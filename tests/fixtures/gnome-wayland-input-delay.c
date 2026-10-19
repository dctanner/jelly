/* Qualification only: loaded solely into a disposable headless compositor.
 * Delay ACTUAL native dispatch, not D-Bus replies. Independently pause an
 * already-selected idle capture's seat query to exercise the input/capture race.
 * Never installed/loaded into Jelly or the existing user's compositor.
 */
#define _GNU_SOURCE
#include <gio/gio.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void write_number(const char *variable, int value) {
  const char *path = getenv(variable);
  if (!path) return;
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return;
  char buffer[32];
  int len = snprintf(buffer, sizeof buffer, "%d", value);
  if (len > 0) (void)write(fd, buffer, len);
  close(fd);
}

/* The real query is in the separate Clutter DSO and is interposable. No seat
 * state is modified. The gate fires ONLY inside a DEFAULT_IDLE callback, after
 * GLib selected it and checked higher-priority event-source readiness.
 */
gboolean clutter_seat_query_state(gpointer seat, gpointer sprite,
                                   gpointer coords, gpointer modifiers) {
  typedef gboolean (*Query)(gpointer, gpointer, gpointer, gpointer);
  typedef gboolean (*EventsPending)(void);
  Query real_query = (Query)dlsym(RTLD_NEXT, "clutter_seat_query_state");
  EventsPending pending = (EventsPending)dlsym(RTLD_NEXT, "clutter_events_pending");
  if (!real_query || !pending) _exit(71);
  const char *gate = getenv("JELLY_FIXTURE_QUERY_GATE");
  GSource *source = g_main_current_source();
  gboolean held = gate && coords && !modifiers && source &&
      g_source_get_priority(source) == G_PRIORITY_DEFAULT_IDLE && access(gate, F_OK) == 0;
  if (held) {
    write_number("JELLY_FIXTURE_QUERY_BLOCKED", 1);
    while (access(gate, F_OK) == 0) g_usleep(1000);
  }
  gboolean result = real_query(seat, sprite, coords, modifiers);
  if (held) write_number("JELLY_FIXTURE_QUERY_PENDING", pending());
  return result;
}

typedef void (*SetCallback)(GSource *, GSourceFunc, gpointer, GDestroyNotify);
typedef struct {
  GSourceFunc dispatch;
  gpointer data;
  GDestroyNotify destroy;
  int serial;
} DelayedTask;
static gint queued;

static gboolean dispatch_delayed(gpointer data) {
  DelayedTask *delayed = data;
  const char *gate = getenv("JELLY_FIXTURE_INPUT_GATE");
  if (gate && access(gate, F_OK) == 0) {
    write_number("JELLY_FIXTURE_INPUT_BLOCKED", 1);
    while (access(gate, F_OK) == 0) g_usleep(1000);
  }
  gboolean result = delayed->dispatch(delayed->data);
  write_number("JELLY_FIXTURE_INPUT_COMPLETED", delayed->serial);
  return result;
}

static void free_delayed(gpointer data) {
  DelayedTask *delayed = data;
  if (delayed->destroy) delayed->destroy(delayed->data);
  g_free(delayed);
}

/* Packaged Mutter calls this symbol internally directly, so interpose its GLib
 * call rather than meta_seat_impl_run_input_task itself. Callback/data lifetime
 * and source priority/order are unchanged; all dispatch happens on the original
 * compositor input thread. Files contain counters/booleans, NEVER keys/text.
 */
void g_source_set_callback(GSource *source, GSourceFunc callback,
                           gpointer data, GDestroyNotify notify) {
  SetCallback real_set = (SetCallback)dlsym(RTLD_NEXT, "g_source_set_callback");
  if (!real_set) _exit(70);
  Dl_info info = {0};
  if (dladdr(__builtin_return_address(0), &info) && info.dli_sname &&
      strcmp(info.dli_sname, "meta_seat_impl_run_input_task") == 0) {
    DelayedTask *delayed = g_new0(DelayedTask, 1);
    delayed->dispatch = callback;
    delayed->data = data;
    delayed->destroy = notify;
    delayed->serial = g_atomic_int_add(&queued, 1) + 1;
    write_number("JELLY_FIXTURE_INPUT_QUEUED", delayed->serial);
    real_set(source, dispatch_delayed, delayed, free_delayed);
  } else {
    real_set(source, callback, data, notify);
  }
}

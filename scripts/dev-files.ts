import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

const inside = (file: string, root: string) =>
  file === root || file.startsWith(root + sep);
const canonical = (path: string) =>
  existsSync(path) ? realpathSync(path) : resolve(path);

/** Serve frontend inputs, not the repository, instance data, or arbitrary @fs files. */
export function privateDevFiles(): Plugin {
  return {
    name: "jelly-private-dev-files",
    configureServer(server) {
      const root = server.config.root;
      const allowed = [
        "src/client",
        "src/shared",
        "node_modules",
        "public",
        "index.html",
      ].map((path) => canonical(resolve(root, path)));
      const privatePaths = [
        resolve(root, ".jelly"),
        resolve(root, process.env.JELLY_DATA_DIR ?? ".jelly"),
        resolve(root, process.env.JELLY_AUTH_FILE ?? ".jelly/auth.json"),
        resolve(
          root,
          process.env.JELLY_CONFIG_DIR ?? resolve(homedir(), ".jelly"),
        ),
      ];
      server.middlewares.use((req, res, next) => {
        const rawPath = (req.url ?? "/").split(/[?#]/)[0]!;
        let path: string;
        try {
          path = decodeURIComponent(rawPath);
        } catch {
          res.statusCode = 400;
          res.end("Invalid path.");
          return;
        }
        // API authorization remains in the API server. These are Vite's virtual modules.
        if (
          rawPath.startsWith("/api/") ||
          ["/@vite/client", "/@vite/env", "/@react-refresh"].includes(rawPath)
        )
          return next();
        const deny = () => {
          res.statusCode = 403;
          res.setHeader("Cache-Control", "no-store");
          res.end("This file is not a frontend asset.");
        };
        if (
          path.includes("\\") ||
          path.includes("\0") ||
          path
            .split("/")
            .some((part) => part.startsWith(".") && part !== ".vite")
        )
          return deny();
        let file: string;
        if (path.startsWith("/@fs/")) {
          const absolute = path.slice("/@fs/".length);
          file = resolve(isAbsolute(absolute) ? absolute : "/" + absolute);
        } else {
          const publicFile = resolve(root, "public", "." + path);
          file =
            path === "/"
              ? resolve(root, "index.html")
              : existsSync(publicFile)
                ? publicFile
                : resolve(root, "." + path);
        }
        try {
          file = canonical(file);
          const allowedRoot = allowed.find((dir) => inside(file, dir));
          if (
            !allowedRoot ||
            relative(allowedRoot, file)
              .split(sep)
              .some((part) => part.startsWith(".") && part !== ".vite") ||
            privatePaths.some((privatePath) =>
              inside(file, canonical(privatePath)),
            )
          )
            return deny();
        } catch {
          return deny();
        }
        next();
      });
    },
  };
}

import { AVATARS } from "../shared/avatars";
import type { AgentRecord } from "../shared/types";

export function Avatar({
  agent,
  size = "",
  working = false,
}: {
  agent: Pick<AgentRecord, "name" | "color"> & { avatarId?: string };
  size?: string;
  working?: boolean;
}) {
  const id = AVATARS.includes(agent.avatarId as never)
    ? agent.avatarId!
    : "jellyfish";
  const index = AVATARS.indexOf(id as never);
  return (
    <img
      className={`avatar ${size}`}
      src={`/brand/avatars/${String(index + 1).padStart(2, "0")}-${id}${working ? "-working" : ""}.png`}
      alt=""
    />
  );
}

export const AVATARS = [
  "jellyfish",
  "octopus",
  "whale",
  "sea-turtle",
  "crab",
  "pufferfish",
  "seahorse",
  "manta-ray",
  "starfish",
  "seal",
  "clownfish",
  "nudibranch",
] as const;
export type AvatarId = (typeof AVATARS)[number];

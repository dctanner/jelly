/** Explicit test/preview injection; production has no scripted provider or bypass. */
import { startApp as startProductionApp, type AppOptions } from "../../src/server/app";
import { Harness } from "../../src/server/harness";
import { MODEL_OPTIONS } from "../../src/shared/models";
import { fixtureModel, fixtureStream } from "./model";

export interface FixtureOptions {
  fixtureDelayMs?: number;
  fixtureFail?: boolean;
}
export function useTestModel(harness: Harness, options: FixtureOptions = {}) {
  harness.runtime.registerProvider("openai", {
    api: "openai-responses",
    baseUrl: fixtureModel.baseUrl,
    apiKey: "test-only-not-a-real-key",
    models: MODEL_OPTIONS.map(({ id }) => ({ ...fixtureModel, id })),
    streamSimple: fixtureStream(options.fixtureDelayMs ?? 1, options.fixtureFail ?? false),
  });
}
export async function startApp(options: AppOptions & FixtureOptions) {
  const app = await startProductionApp(options);
  useTestModel(app.service.harness, options);
  app.service.setMode("api");
  return app;
}

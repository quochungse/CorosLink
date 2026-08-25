import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");

const mainSource = read("electron/main.ts");
const preloadSource = read("electron/preload.ts");
const apiSource = read("src/coroslink-api.ts");

// A channel name is a plain string in three separate files, so a typo in any
// one of them typechecks cleanly and fails only at runtime. These are the
// invariants TypeScript cannot see.
const handled = new Set(
  [...mainSource.matchAll(/ipcMain\.handle\(\s*\n?\s*"([^"]+)"/g)].map((m) => m[1])
);
const invoked = new Set(
  [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*\n?\s*"([^"]+)"/g)].map((m) => m[1])
);
const listened = new Set(
  [...preloadSource.matchAll(/ipcRenderer\.on\("([^"]+)"/g)].map((m) => m[1])
);

assert.ok(handled.size > 100, "handler scrape found nothing; the regex has drifted");
assert.ok(invoked.size > 100, "invoke scrape found nothing; the regex has drifted");

assert.deepEqual(
  [...invoked].filter((channel) => !handled.has(channel)).sort(),
  [],
  "preload invokes a channel main.ts does not handle"
);
assert.deepEqual(
  [...handled].filter((channel) => !invoked.has(channel)).sort(),
  [],
  "main.ts handles a channel nothing invokes"
);

// --- section 8: the coach automation surface -------------------------------
const SECTION_8_CHANNELS = [
  "coachAutomation:list",
  "coachAutomation:get",
  "coachAutomation:save",
  "coachAutomation:setEnabled",
  "coachAutomation:delete",
  "coachAutomation:listBindings",
  "coachAutomation:attach",
  "coachAutomation:detach",
  "coachAutomation:setBindingEnabled",
  "coachAutomation:reorderBindings",
  "coachAutomation:listForSession",
  "coachAutomation:runNow",
  "coachAutomation:listRuns",
  "coachAutomation:cancelRun",
  "coachAutomation:markSeen",
  "chat:renameSession"
];

for (const channel of SECTION_8_CHANNELS) {
  assert.ok(handled.has(channel), `main.ts is missing a handler for ${channel}`);
  assert.ok(invoked.has(channel), `preload.ts never invokes ${channel}`);
}

// The one push channel: emitted by the runner, listened for in preload.
assert.ok(
  listened.has("coachAutomation:runUpdate"),
  "preload does not subscribe to coachAutomation:runUpdate"
);
assert.match(
  read("electron/coachAutomationService.ts"),
  /"coachAutomation:runUpdate"/,
  "nothing emits coachAutomation:runUpdate"
);
assert.equal(
  handled.has("coachAutomation:runUpdate"),
  false,
  "a push channel must not also be an invoke handler"
);

// --- preload's shape and the renderer's view of it must agree --------------
// electron/preload.ts exports `CorosLinkApi = typeof api` while
// src/coroslink-api.ts declares its own interface of the same name. Nothing
// links the two at compile time, so they are compared here instead.
function topLevelKeys(source, startPattern, closing) {
  const start = new RegExp(startPattern).exec(source);
  assert.ok(start, `could not locate ${startPattern}`);
  const body = source.slice(start.index + start[0].length);
  const end = body.indexOf(closing);
  assert.ok(end > 0, `could not find the end of ${startPattern}`);
  return new Set(
    [...body.slice(0, end).matchAll(/^ {2}([A-Za-z_$][\w$]*)\??\s*[:(]/gm)].map(
      (match) => match[1]
    )
  );
}

const preloadKeys = topLevelKeys(preloadSource, "const api = \\{", "\n};");
const apiKeys = topLevelKeys(apiSource, "export interface CorosLinkApi \\{", "\n}");
assert.ok(preloadKeys.size > 200, "preload key scrape has drifted");

assert.deepEqual(
  [...preloadKeys].filter((key) => !apiKeys.has(key)).sort(),
  [],
  "preload exposes a method the renderer's CorosLinkApi does not declare"
);
assert.deepEqual(
  [...apiKeys].filter((key) => !preloadKeys.has(key)).sort(),
  [],
  "the renderer's CorosLinkApi declares a method preload does not expose"
);

// Every automation method reaches the renderer under a name it can call.
for (const method of [
  "renameChatSession",
  "listCoachAutomations",
  "getCoachAutomation",
  "saveCoachAutomation",
  "setCoachAutomationEnabled",
  "deleteCoachAutomation",
  "listCoachAutomationBindings",
  "attachCoachAutomation",
  "detachCoachAutomation",
  "setCoachAutomationBindingEnabled",
  "reorderCoachAutomationBindings",
  "listCoachAutomationsForSession",
  "runCoachAutomationNow",
  "listCoachAutomationRuns",
  "cancelCoachAutomationRun",
  "markCoachAutomationRunsSeen",
  "onCoachAutomationRunUpdate",
  "getCoachAutomationPause",
  "resumeCoachAutomations",
  "onCoachAutomationPauseUpdate",
  "getCoachAutomationSpend",
  "setCoachAutomationBudget"
]) {
  assert.ok(apiKeys.has(method), `CorosLinkApi is missing ${method}`);
}

console.log("ipc surface tests passed");

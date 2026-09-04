import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, '..', 'App.js');
let source = readFileSync(appPath, 'utf8');
let changed = false;

const oldInput = "      const input = await recorder.getCurrentInput().catch(() => null);\n      setInputName(input?.name || input?.type || 'Built-in microphone');";
const newInput = `      let input = null;\n      try {\n        if (typeof recorder.getCurrentInput === 'function') {\n          input = await recorder.getCurrentInput();\n        }\n      } catch {\n        // Input-name detection is optional and must never block recording.\n      }\n      setInputName(input?.name || input?.type || 'Built-in microphone');`;
if (source.includes(oldInput)) {
  source = source.replace(oldInput, newInput);
  changed = true;
}

const oldActivate = "      if (settings.keepScreenAwake) await KeepAwake.activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});";
const newActivate = `      if (settings.keepScreenAwake) {\n        try {\n          if (typeof KeepAwake.activateKeepAwakeAsync === 'function') {\n            await KeepAwake.activateKeepAwakeAsync(KEEP_AWAKE_TAG);\n          } else if (typeof KeepAwake.activateKeepAwake === 'function') {\n            await KeepAwake.activateKeepAwake(KEEP_AWAKE_TAG);\n          }\n        } catch {\n          // Keep-awake is helpful, but recording must still start if it is unavailable.\n        }\n      }`;
if (source.includes(oldActivate)) {
  source = source.replace(oldActivate, newActivate);
  changed = true;
}

const oldUnmount = "    KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});";
const newUnmount = `    try {\n      if (typeof KeepAwake.deactivateKeepAwake === 'function') {\n        Promise.resolve(KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => {});\n      }\n    } catch {\n      // Best-effort cleanup only.\n    }`;
if (source.includes(oldUnmount)) {
  source = source.replace(oldUnmount, newUnmount);
  changed = true;
}

const oldFinish = "      await KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});";
const newFinish = `      try {\n        if (typeof KeepAwake.deactivateKeepAwake === 'function') {\n          await Promise.resolve(KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG));\n        }\n      } catch {\n        // Best-effort cleanup only.\n      }`;
while (source.includes(oldFinish)) {
  source = source.replace(oldFinish, newFinish);
  changed = true;
}

const oldWarning = "      setWarning(error instanceof Error ? error.message : 'Could not start recording.');";
const newWarning = "      setWarning(`Recorder start failed: ${error instanceof Error ? error.message : 'Could not start recording.'}`);";
if (source.includes(oldWarning)) {
  source = source.replace(oldWarning, newWarning);
  changed = true;
}

if (changed) {
  writeFileSync(appPath, source, 'utf8');
  console.log('Applied LectureAI Expo SDK 57 recorder compatibility hotfix.');
} else {
  console.log('LectureAI recorder compatibility hotfix already applied.');
}

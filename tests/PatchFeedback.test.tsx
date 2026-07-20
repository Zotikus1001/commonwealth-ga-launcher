import { describe, expect, it } from 'vitest';
import { manualPatchErrorMessage } from '../src/renderer/src/screens/Settings';

describe('manual patch feedback', () => {
  it('uses the persistent patch state as the only successful status', () => {
    expect(manualPatchErrorMessage({ ok: true, message: 'Patch applied.' })).toBeNull();
    expect(manualPatchErrorMessage({ ok: true, message: 'Patch removed.' })).toBeNull();
  });

  it('keeps detailed failures visible', () => {
    expect(manualPatchErrorMessage({ ok: false, message: 'Could not write TgEngine.ini.' })).toBe(
      'Could not write TgEngine.ini.'
    );
  });
});

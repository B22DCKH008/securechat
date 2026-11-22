/** Chép văn bản. `navigator.clipboard` chỉ có ở secure context nên có đường dự phòng bằng execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = (globalThis.navigator as Partial<Navigator> | undefined)?.clipboard;
    if (clip?.writeText) {
      await clip.writeText(text);
      return true;
    }
  } catch {
    /* thử đường dự phòng */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

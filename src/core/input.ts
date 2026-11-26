/** Keyboard + gamepad state with edge-triggered presses. */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private padPrev: boolean[] = [];
  private padNow: boolean[] = [];
  private axes: number[] = [0, 0, 0, 0];
  private triggers = [0, 0];
  /** Set while a text field or modal wants the keyboard. */
  enabled = true;
  private listeners: ((code: string) => void)[] = [];

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      for (const l of this.listeners) l(e.code);
    });
    target.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    target.addEventListener('blur', () => {
      for (const c of this.down) this.released.add(c);
      this.down.clear();
    });
  }

  onKey(fn: (code: string) => void) {
    this.listeners.push(fn);
  }

  /** Call once per frame before reading. */
  poll() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    this.padPrev = this.padNow;
    this.padNow = [];
    if (pad) {
      this.padNow = pad.buttons.map((b) => b.pressed);
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      this.axes = [dz(pad.axes[0] ?? 0), dz(pad.axes[1] ?? 0), dz(pad.axes[2] ?? 0), dz(pad.axes[3] ?? 0)];
      this.triggers = [pad.buttons[6]?.value ?? 0, pad.buttons[7]?.value ?? 0];
    } else {
      this.axes = [0, 0, 0, 0];
      this.triggers = [0, 0];
    }
  }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
  }

  isDown(...codes: string[]) {
    if (!this.enabled) return false;
    return codes.some((c) => this.down.has(c));
  }

  wasPressed(...codes: string[]) {
    if (!this.enabled) return false;
    return codes.some((c) => this.pressed.has(c));
  }

  padDown(i: number) {
    return !!this.padNow[i];
  }

  padPressed(i: number) {
    return !!this.padNow[i] && !this.padPrev[i];
  }

  axis(i: number) {
    return this.axes[i] ?? 0;
  }

  trigger(i: number) {
    return this.triggers[i] ?? 0;
  }

  /** -1..1 from two key groups plus an optional gamepad axis. */
  keyAxis(neg: string[], pos: string[], padAxis = -1) {
    let v = 0;
    if (this.isDown(...neg)) v -= 1;
    if (this.isDown(...pos)) v += 1;
    if (padAxis >= 0 && v === 0) v = this.axis(padAxis);
    return v;
  }
}

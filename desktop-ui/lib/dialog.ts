"use client";

export interface PromptOptions {
  title: string;
  defaultValue?: string;
  placeholder?: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Style the action button red (delete-style). Default false. */
  danger?: boolean;
  /** Override the default "OK" / "Delete" button label. */
  okLabel?: string;
}

export type DialogRequest =
  | { id: number; kind: "prompt"; opts: PromptOptions; resolve: (value: string | null) => void }
  | { id: number; kind: "confirm"; opts: ConfirmOptions; resolve: (ok: boolean) => void };

type Listener = (req: DialogRequest | null) => void;

class DialogService {
  private listeners = new Set<Listener>();
  private current: DialogRequest | null = null;
  private queue: DialogRequest[] = [];
  private nextId = 1;

  prompt(opts: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      this.push({ id: this.nextId++, kind: "prompt", opts, resolve });
    });
  }

  confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      this.push({ id: this.nextId++, kind: "confirm", opts, resolve });
    });
  }

  /** Resolve the current dialog and advance the queue. */
  resolveCurrent(value: string | boolean | null): void {
    const cur = this.current;
    if (!cur) return;
    if (cur.kind === "prompt") cur.resolve(value as string | null);
    else cur.resolve(value as boolean);
    this.current = null;
    this.advance();
  }

  /** Cancel the current dialog (Esc / outside click / ✕). */
  cancelCurrent(): void {
    const cur = this.current;
    if (!cur) return;
    if (cur.kind === "prompt") cur.resolve(null);
    else cur.resolve(false);
    this.current = null;
    this.advance();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.current);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private push(req: DialogRequest): void {
    this.queue.push(req);
    this.advance();
  }

  private advance(): void {
    if (this.current) return;
    this.current = this.queue.shift() ?? null;
    for (const l of this.listeners) l(this.current);
  }
}

let singleton: DialogService | null = null;

export function getDialog(): DialogService {
  if (!singleton) singleton = new DialogService();
  return singleton;
}

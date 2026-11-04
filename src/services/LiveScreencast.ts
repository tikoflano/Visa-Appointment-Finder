import type { CDPSession, Page } from "playwright";
import WebSocket from "ws";

/**
 * Connects a Playwright page to the management LiveHub and streams CDP
 * screencast frames only while the hub asks for them (admin Live page open).
 */
const MIN_FRAME_INTERVAL_MS = 500;

export class LiveScreencast {
  private readonly page: Page;
  private ws: WebSocket | undefined;
  private cdp: CDPSession | undefined;
  private want = false;
  private casting = false;
  private closed = false;
  private lastSentAt = 0;

  constructor(page: Page) {
    this.page = page;
  }

  /** No-op when VISA_LIVE_URL / VISA_LIVE_TOKEN are unset. */
  async start(): Promise<void> {
    const url = process.env.VISA_LIVE_URL?.trim();
    const token = process.env.VISA_LIVE_TOKEN?.trim();
    if (!url || !token || this.closed) return;

    const separator = url.includes("?") ? "&" : "?";
    const target = `${url}${separator}token=${encodeURIComponent(token)}`;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      try {
        this.ws = new WebSocket(target);
      } catch {
        done();
        return;
      }

      this.ws.on("open", () => done());
      this.ws.on("error", () => done());
      this.ws.on("close", () => {
        this.want = false;
        void this.syncCast();
        done();
      });
      this.ws.on("message", (raw) => {
        let message: { type?: string; on?: boolean };
        try {
          message = JSON.parse(String(raw)) as { type?: string; on?: boolean };
        } catch {
          return;
        }
        if (message.type !== "screencast") return;
        this.want = !!message.on;
        void this.syncCast();
      });

      setTimeout(done, 3000).unref?.();
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.want = false;
    await this.stopCast();
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  private async syncCast(): Promise<void> {
    if (this.want && !this.casting && !this.closed) {
      await this.startCast();
    } else if (!this.want && this.casting) {
      await this.stopCast();
    }
  }

  private async startCast(): Promise<void> {
    if (this.casting || this.closed) return;
    try {
      this.cdp = await this.page.context().newCDPSession(this.page);
      this.cdp.on("Page.screencastFrame", (event) => {
        void this.onFrame(event.data, event.sessionId);
      });
      await this.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 40,
        maxWidth: 800,
        maxHeight: 600,
        // Keep CDP quiet so the management server can still run the scheduler.
        everyNthFrame: 2,
      });
      this.casting = true;
    } catch (error) {
      console.error("Live screencast start failed:", error);
      await this.stopCast();
    }
  }

  private async onFrame(jpeg: string, sessionId: number): Promise<void> {
    const ws = this.ws;
    const cdp = this.cdp;
    if (!cdp) return;
    // Always ack so Chromium does not stall; only forward a throttled subset.
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId });
    } catch {
      /* ignore */
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - this.lastSentAt < MIN_FRAME_INTERVAL_MS) return;
    this.lastSentAt = now;
    try {
      ws.send(JSON.stringify({ type: "frame", jpeg }));
    } catch {
      /* ignore */
    }
  }

  private async stopCast(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    this.casting = false;
    if (!cdp) return;
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      /* ignore */
    }
    try {
      await cdp.detach();
    } catch {
      /* ignore */
    }
  }
}

import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { WebSocket, WebSocketServer } from "ws";

export interface LiveBotInfo {
  profileId: number;
  runId: number;
  profileName: string;
}

type ViewerMessage =
  | {
      type: "hello";
      screencasting: boolean;
      bots: LiveBotInfo[];
    }
  | {
      type: "bot";
      event: "connected" | "disconnected";
      profileId: number;
      runId: number;
      profileName: string;
    }
  | {
      type: "frame";
      profileId: number;
      runId: number;
      jpeg: string;
    }
  | { type: "screencasting"; on: boolean }
  | { type: "profiles"; profiles: unknown[] };

type BotInbound = { type: "frame"; jpeg?: string };

interface BotSocket {
  ws: WebSocket;
  info: LiveBotInfo;
}

interface SseViewer {
  res: ServerResponse;
}

/**
 * Relays Playwright CDP screencast frames from bot children to admin viewers
 * over SSE. Screencast is only requested while at least one viewer is connected.
 */
export class LiveHub {
  private readonly viewers = new Set<SseViewer>();
  private readonly bots = new Map<number, BotSocket>();
  private readonly tokens = new Map<string, LiveBotInfo>();
  private readonly lastFrames = new Map<number, string>();
  private readonly botServer: WebSocketServer;
  private snapshotProfiles: (() => Promise<unknown[]>) | undefined;
  private onFirstViewer: (() => void) | undefined;
  private onLastViewer: (() => void) | undefined;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private snapshotQueued = false;

  constructor() {
    this.botServer = new WebSocketServer({ noServer: true });
    this.botServer.on("connection", (ws, req) => this.onBot(ws, req));
  }

  configure(options: {
    snapshotProfiles: () => Promise<unknown[]>;
    onFirstViewer?: () => void;
    onLastViewer?: () => void;
  }): void {
    this.snapshotProfiles = options.snapshotProfiles;
    this.onFirstViewer = options.onFirstViewer;
    this.onLastViewer = options.onLastViewer;
  }

  /** Register a run and return an unguessable token for the child process. */
  registerRun(
    runId: number,
    profileId: number,
    profileName: string,
  ): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.tokens.set(token, { runId, profileId, profileName });
    return token;
  }

  /** Drop the run token, close its bot socket, and notify viewers. */
  revokeRun(runId: number): void {
    for (const [token, info] of this.tokens) {
      if (info.runId === runId) this.tokens.delete(token);
    }
    const bot = this.bots.get(runId);
    if (bot) {
      this.bots.delete(runId);
      this.lastFrames.delete(bot.info.profileId);
      try {
        bot.ws.close();
      } catch {
        /* ignore */
      }
      this.broadcastViewers({
        type: "bot",
        event: "disconnected",
        ...bot.info,
      });
    }
    this.queueProfilesSnapshot();
  }

  /** Push a fresh profiles snapshot to SSE viewers (scheduler state changed). */
  notifyStateChanged(): void {
    this.queueProfilesSnapshot();
  }

  viewerCount(): number {
    return this.viewers.size;
  }

  handleBotUpgrade(
    req: IncomingMessage,
    socket: import("stream").Duplex,
    head: Buffer,
  ): void {
    this.botServer.handleUpgrade(req, socket, head, (ws) => {
      this.botServer.emit("connection", ws, req);
    });
  }

  /** Open an admin SSE stream for frames + profile state. */
  handleSse(req: IncomingMessage, res: ServerResponse): void {
    const becameFirst = this.viewers.size === 0;
    const viewer: SseViewer = { res };
    this.viewers.add(viewer);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Flush headers for proxies; comment keeps some intermediaries awake.
    res.write(": connected\n\n");

    const hello: ViewerMessage = {
      type: "hello",
      screencasting: true,
      bots: [...this.bots.values()].map((bot) => bot.info),
    };
    this.writeSse(viewer, hello);

    for (const [profileId, jpeg] of this.lastFrames) {
      const bot = [...this.bots.values()].find(
        (entry) => entry.info.profileId === profileId,
      );
      if (!bot) continue;
      this.writeSse(viewer, {
        type: "frame",
        profileId,
        runId: bot.info.runId,
        jpeg,
      });
    }

    void this.sendProfilesTo(viewer);

    if (becameFirst) {
      this.setScreencast(true);
      this.onFirstViewer?.();
    }

    const heartbeat = setInterval(() => {
      if (!this.viewers.has(viewer)) return;
      try {
        res.write(": ping\n\n");
      } catch {
        this.removeViewer(viewer);
      }
    }, 15000);
    heartbeat.unref?.();

    const onClose = () => {
      clearInterval(heartbeat);
      this.removeViewer(viewer);
    };
    req.on("close", onClose);
    res.on("close", onClose);
  }

  private removeViewer(viewer: SseViewer): void {
    if (!this.viewers.delete(viewer)) return;
    try {
      viewer.res.end();
    } catch {
      /* ignore */
    }
    if (this.viewers.size === 0) {
      this.setScreencast(false);
      try {
        this.onLastViewer?.();
      } catch (error) {
        console.error("Live onLastViewer failed:", error);
      }
    }
  }

  private onBot(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || "/", "http://localhost");
    const token = url.searchParams.get("token") || "";
    const info = this.tokens.get(token);
    if (!info) {
      ws.close(4401, "Invalid token");
      return;
    }

    const previous = this.bots.get(info.runId);
    if (previous && previous.ws !== ws) {
      try {
        previous.ws.close();
      } catch {
        /* ignore */
      }
    }

    this.bots.set(info.runId, { ws, info });
    this.broadcastViewers({
      type: "bot",
      event: "connected",
      ...info,
    });
    this.queueProfilesSnapshot();

    if (this.viewers.size > 0) {
      this.sendBot(ws, { type: "screencast", on: true });
    }

    ws.on("message", (raw) => {
      let message: BotInbound;
      try {
        message = JSON.parse(String(raw)) as BotInbound;
      } catch {
        return;
      }
      if (message.type !== "frame" || typeof message.jpeg !== "string") return;
      if (!message.jpeg || message.jpeg.length > 2_000_000) return;

      this.lastFrames.set(info.profileId, message.jpeg);
      this.broadcastViewers({
        type: "frame",
        profileId: info.profileId,
        runId: info.runId,
        jpeg: message.jpeg,
      });
    });

    ws.on("close", () => {
      const current = this.bots.get(info.runId);
      if (current?.ws === ws) {
        this.bots.delete(info.runId);
        this.lastFrames.delete(info.profileId);
        this.broadcastViewers({
          type: "bot",
          event: "disconnected",
          ...info,
        });
        this.queueProfilesSnapshot();
      }
    });
  }

  private setScreencast(on: boolean): void {
    this.broadcastViewers({ type: "screencasting", on });
    for (const bot of this.bots.values()) {
      this.sendBot(bot.ws, { type: "screencast", on });
    }
  }

  private queueProfilesSnapshot(): void {
    if (!this.snapshotProfiles || this.viewers.size === 0) return;
    if (this.snapshotQueued) return;
    this.snapshotQueued = true;
    // Coalesce bursts (enqueue + start + bot connect) into one push.
    this.snapshotTimer = setTimeout(() => {
      this.snapshotQueued = false;
      void this.broadcastProfiles();
    }, 50);
    this.snapshotTimer.unref?.();
  }

  private async broadcastProfiles(): Promise<void> {
    if (!this.snapshotProfiles || this.viewers.size === 0) return;
    try {
      const profiles = await this.snapshotProfiles();
      this.broadcastViewers({ type: "profiles", profiles });
    } catch (error) {
      console.error("Live profiles snapshot failed:", error);
    }
  }

  private async sendProfilesTo(viewer: SseViewer): Promise<void> {
    if (!this.snapshotProfiles) return;
    try {
      const profiles = await this.snapshotProfiles();
      this.writeSse(viewer, { type: "profiles", profiles });
    } catch (error) {
      console.error("Live profiles snapshot failed:", error);
    }
  }

  private broadcastViewers(message: ViewerMessage): void {
    for (const viewer of [...this.viewers]) {
      this.writeSse(viewer, message);
    }
  }

  private writeSse(viewer: SseViewer, message: ViewerMessage): void {
    if (!this.viewers.has(viewer)) return;
    try {
      viewer.res.write(`data: ${JSON.stringify(message)}\n\n`);
    } catch {
      this.removeViewer(viewer);
    }
  }

  private sendBot(ws: WebSocket, message: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* ignore */
    }
  }
}

/** Loopback WebSocket URL bots use to reach this process. */
export function liveBotUrl(port: number): string {
  return `ws://127.0.0.1:${port}/api/live/bot`;
}

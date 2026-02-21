import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  MAEventMessage,
  MAResultErrorMessage,
  MAResultSuccessMessage,
  MAServerInfoMessage,
} from './types';

export type MAConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'authenticating'
  | 'authenticated'
  | 'error';

export interface MAStatusSnapshot {
  state: MAConnectionState;
  message: string;
  connected: boolean;
  authenticated: boolean;
  authRequired: boolean;
  serverInfo: MAServerInfoMessage | null;
}

type StatusListener = (status: MAStatusSnapshot) => void;
type EventListener = (event: MAEventMessage) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  partialResults: unknown[];
}

const COMMAND_TIMEOUT_MS = 12000;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed) || /^wss?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function toWebSocketUrl(baseUrl: string): string {
  let wsUrl = baseUrl;
  if (wsUrl.startsWith('https://')) wsUrl = wsUrl.replace('https://', 'wss://');
  if (wsUrl.startsWith('http://')) wsUrl = wsUrl.replace('http://', 'ws://');
  if (!wsUrl.endsWith('/ws')) wsUrl = `${wsUrl}/ws`;
  return wsUrl.replace('//ws', '/ws');
}

function parseServerInfo(message: Record<string, unknown>): MAServerInfoMessage | null {
  const serverId = message.server_id;
  const serverVersion = message.server_version;
  const schemaVersion = message.schema_version;

  if (
    typeof serverId !== 'string' ||
    typeof serverVersion !== 'string' ||
    typeof schemaVersion !== 'number'
  ) {
    return null;
  }

  const minSupported = message.min_supported_schema_version;

  return {
    server_id: serverId,
    server_version: serverVersion,
    schema_version: schemaVersion,
    min_supported_schema_version:
      typeof minSupported === 'number' ? minSupported : undefined,
  };
}

function parseEventMessage(message: Record<string, unknown>): MAEventMessage | null {
  const event = message.event;
  if (typeof event !== 'string') return null;

  const objectId = message.object_id;
  return {
    event,
    object_id: typeof objectId === 'string' ? objectId : undefined,
    data: message.data,
  };
}

function parseResultMessage(
  message: Record<string, unknown>,
): MAResultSuccessMessage | MAResultErrorMessage | null {
  const messageId = message.message_id;
  if (typeof messageId !== 'string') return null;

  const errorCode = message.error_code;
  if (typeof errorCode === 'string') {
    return {
      message_id: messageId,
      error_code: errorCode,
      details: typeof message.details === 'string' ? message.details : undefined,
    };
  }

  return {
    message_id: messageId,
    result: message.result,
    partial: message.partial === true,
  };
}

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Buffer) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

export class MusicAssistantClient {
  private ws: WebSocket | null = null;

  private baseUrl = '';

  private authToken = '';

  private state: MAConnectionState = 'disconnected';

  private message = 'Not connected.';

  private authenticated = false;

  private serverInfo: MAServerInfoMessage | null = null;

  private readonly pending = new Map<string, PendingRequest>();

  private readonly statusListeners = new Set<StatusListener>();

  private readonly eventListeners = new Set<EventListener>();

  private connectPromise: Promise<void> | null = null;

  setCredentials(baseUrl: string, token: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.authToken = token.trim();
  }

  setAuthToken(token: string): void {
    this.authToken = token.trim();
  }

  getStatus(): MAStatusSnapshot {
    const authRequired =
      this.serverInfo?.schema_version !== undefined &&
      this.serverInfo.schema_version >= 28 &&
      !this.authenticated;

    return {
      state: this.state,
      message: this.message,
      connected: this.ws?.readyState === WebSocket.OPEN,
      authenticated: this.authenticated,
      authRequired,
      serverInfo: this.serverInfo,
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private updateStatus(
    state: MAConnectionState,
    message: string,
    authenticated?: boolean,
  ): void {
    this.state = state;
    this.message = message;
    if (typeof authenticated === 'boolean') {
      this.authenticated = authenticated;
    }
    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const run = async () => {
      if (!this.baseUrl) {
        throw new Error('Music Assistant URL is not configured.');
      }

      this.disconnect('Reconnecting…');

      this.serverInfo = null;
      this.authenticated = false;
      this.updateStatus('connecting', 'Connecting to Music Assistant…', false);

      const wsUrl = toWebSocketUrl(this.baseUrl);
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timed out.'));
        }, 8000);

        socket.once('open', () => {
          clearTimeout(timeout);
          this.updateStatus('connected', 'Connected. Waiting for server info…', false);
          resolve();
        });

        socket.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      }).catch((error: unknown) => {
        this.updateStatus('error', `Connection failed: ${toErrorMessage(error)}`, false);
        this.disconnect('Disconnected after connection error.');
        throw error;
      });

      socket.on('message', (raw) => {
        if (this.ws !== socket) return;
        this.handleMessage(rawToString(raw));
      });

      socket.on('close', () => {
        if (this.ws !== socket) return;
        this.updateStatus('disconnected', 'Disconnected from Music Assistant.', false);
        this.rejectPendingRequests('Socket closed.');
        this.ws = null;
      });

      socket.on('error', (error) => {
        if (this.ws !== socket) return;
        this.updateStatus('error', `Socket error: ${toErrorMessage(error)}`, false);
      });
    };

    this.connectPromise = run().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  disconnect(reason = 'Disconnected.'): void {
    const socket = this.ws;
    this.ws = null;

    if (socket) {
      // Prevent unhandled "WebSocket was closed before the connection was established"
      // when tearing down a CONNECTING socket.
      socket.on('error', () => undefined);
      try {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        } else if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      } catch {
        // best effort
      }
    }

    this.rejectPendingRequests(reason);
    this.authenticated = false;
    this.serverInfo = null;
    this.updateStatus('disconnected', reason, false);
  }

  async sendCommand<ResultType>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<ResultType> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Music Assistant.');
    }

    const messageId = randomUUID();

    const payload: Record<string, unknown> = {
      command,
      message_id: messageId,
    };

    if (args && Object.keys(args).length > 0) {
      payload.args = args;
    }

    const resultPromise = new Promise<ResultType>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Music Assistant command timeout: ${command}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(messageId, {
        resolve: (value) => resolve(value as ResultType),
        reject,
        timeout,
        partialResults: [],
      });
    });

    socket.send(JSON.stringify(payload));

    return resultPromise;
  }

  async authenticateWithToken(token: string): Promise<void> {
    if (!token.trim()) {
      throw new Error('Token is empty.');
    }
    if (!this.isConnected()) {
      throw new Error('Not connected to Music Assistant.');
    }

    this.updateStatus('authenticating', 'Authenticating with Music Assistant…', false);
    await this.sendCommand('auth', { token: token.trim() });
    this.authToken = token.trim();
    this.updateStatus('authenticated', 'Connected and authenticated.', true);
  }

  private rejectPendingRequests(message: string): void {
    for (const [messageId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pending.delete(messageId);
    }
  }

  private async handleServerInfo(info: MAServerInfoMessage): Promise<void> {
    this.serverInfo = info;

    if (info.schema_version >= 28) {
      if (!this.authToken) {
        this.updateStatus(
          'connected',
          'Authentication required. Use provider login or set a token.',
          false,
        );
        return;
      }

      try {
        await this.authenticateWithToken(this.authToken);
      } catch (error: unknown) {
        this.updateStatus('error', `Authentication failed: ${toErrorMessage(error)}`, false);
      }
      return;
    }

    this.updateStatus('authenticated', 'Connected.', true);
  }

  private handleResultMessage(message: MAResultSuccessMessage | MAResultErrorMessage): void {
    const pending = this.pending.get(message.message_id);
    if (!pending) return;

    if ('error_code' in message) {
      clearTimeout(pending.timeout);
      this.pending.delete(message.message_id);
      pending.reject(new Error(message.details || message.error_code));
      return;
    }

    if (message.partial) {
      if (Array.isArray(message.result)) {
        pending.partialResults.push(...message.result);
      }
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.message_id);

    if (pending.partialResults.length > 0 && Array.isArray(message.result)) {
      pending.resolve([...pending.partialResults, ...message.result]);
      return;
    }

    pending.resolve(message.result);
  }

  private handleMessage(rawText: string): void {
    let message: unknown;
    try {
      message = JSON.parse(rawText);
    } catch {
      return;
    }

    const parsed = asRecord(message);
    if (!parsed) return;

    const serverInfo = parseServerInfo(parsed);
    if (serverInfo) {
      void this.handleServerInfo(serverInfo);
      return;
    }

    const event = parseEventMessage(parsed);
    if (event) {
      for (const listener of this.eventListeners) {
        listener(event);
      }
      return;
    }

    const result = parseResultMessage(parsed);
    if (result) {
      this.handleResultMessage(result);
    }
  }
}

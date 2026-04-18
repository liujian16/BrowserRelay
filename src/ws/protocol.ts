/**
 * Binary WebSocket protocol for BrowserRelay.
 *
 * Frame layout:
 *   Byte 0:      message type
 *   Bytes 1-16:  requestId (raw UUID bytes, 16 bytes)
 *   Remaining:   type-specific payload
 */

export enum MessageType {
  REQUEST_START  = 0x01,
  REQUEST_CHUNK  = 0x02,
  REQUEST_END    = 0x03,
  RESPONSE_START = 0x11,
  RESPONSE_CHUNK = 0x12,
  RESPONSE_END   = 0x13,
  ABORT          = 0x21,
  ACK            = 0x30,
  PING           = 0x40,
  PONG           = 0x41,
}

export interface DecodedFrame {
  type: MessageType;
  requestId: Uint8Array;
  // REQUEST_START
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  // REQUEST_CHUNK / RESPONSE_CHUNK
  data?: Uint8Array;
  // RESPONSE_START
  status?: number;
  // ACK
  windowBytes?: number;
  // ABORT
  errorMessage?: string;
}

const REQUEST_ID_SIZE = 16;

// --- Encode helpers ---

function writeRequestId(buf: Buffer, offset: number, id: Uint8Array): void {
  buf.set(id, offset);
}

function writeString32BE(buf: Buffer, offset: number, str: string): number {
  const strBuf = Buffer.from(str, 'utf-8');
  buf.writeUInt32BE(strBuf.length, offset);
  strBuf.copy(buf, offset + 4);
  return offset + 4 + strBuf.length;
}

function readString32BE(buf: Buffer, offset: number): { value: string; nextOffset: number } {
  const len = buf.readUInt32BE(offset);
  const value = buf.toString('utf-8', offset + 4, offset + 4 + len);
  return { value, nextOffset: offset + 4 + len };
}

// --- Encode functions ---

export function encodeRequestStart(
  requestId: Uint8Array,
  method: string,
  url: string,
  headers: Record<string, string>,
): Buffer {
  const methodBuf = Buffer.from(method, 'utf-8');
  const urlBuf = Buffer.from(url, 'utf-8');
  const headersBuf = Buffer.from(JSON.stringify(headers), 'utf-8');

  const totalLen = 1 + REQUEST_ID_SIZE + 4 + methodBuf.length + 4 + urlBuf.length + 4 + headersBuf.length;
  const buf = Buffer.alloc(totalLen);

  let offset = 0;
  buf[offset] = MessageType.REQUEST_START;
  offset += 1;
  writeRequestId(buf, offset, requestId);
  offset += REQUEST_ID_SIZE;

  // method
  buf.writeUInt32BE(methodBuf.length, offset);
  methodBuf.copy(buf, offset + 4);
  offset += 4 + methodBuf.length;

  // url
  buf.writeUInt32BE(urlBuf.length, offset);
  urlBuf.copy(buf, offset + 4);
  offset += 4 + urlBuf.length;

  // headers
  buf.writeUInt32BE(headersBuf.length, offset);
  headersBuf.copy(buf, offset + 4);

  return buf;
}

export function encodeRequestChunk(requestId: Uint8Array, data: Uint8Array): Buffer {
  const buf = Buffer.alloc(1 + REQUEST_ID_SIZE + data.length);
  buf[0] = MessageType.REQUEST_CHUNK;
  buf.set(requestId, 1);
  if (data.length > 0) {
    buf.set(data, 1 + REQUEST_ID_SIZE);
  }
  return buf;
}

export function encodeRequestEnd(requestId: Uint8Array): Buffer {
  const buf = Buffer.alloc(1 + REQUEST_ID_SIZE);
  buf[0] = MessageType.REQUEST_END;
  buf.set(requestId, 1);
  return buf;
}

export function encodeResponseStart(
  requestId: Uint8Array,
  status: number,
  headers: Record<string, string>,
): Buffer {
  const headersBuf = Buffer.from(JSON.stringify(headers), 'utf-8');
  const totalLen = 1 + REQUEST_ID_SIZE + 2 + 4 + headersBuf.length;
  const buf = Buffer.alloc(totalLen);

  let offset = 0;
  buf[offset] = MessageType.RESPONSE_START;
  offset += 1;
  writeRequestId(buf, offset, requestId);
  offset += REQUEST_ID_SIZE;

  buf.writeUInt16BE(status, offset);
  offset += 2;

  buf.writeUInt32BE(headersBuf.length, offset);
  headersBuf.copy(buf, offset + 4);

  return buf;
}

export function encodeResponseChunk(requestId: Uint8Array, data: Uint8Array): Buffer {
  const buf = Buffer.alloc(1 + REQUEST_ID_SIZE + data.length);
  buf[0] = MessageType.RESPONSE_CHUNK;
  buf.set(requestId, 1);
  if (data.length > 0) {
    buf.set(data, 1 + REQUEST_ID_SIZE);
  }
  return buf;
}

export function encodeResponseEnd(requestId: Uint8Array): Buffer {
  const buf = Buffer.alloc(1 + REQUEST_ID_SIZE);
  buf[0] = MessageType.RESPONSE_END;
  buf.set(requestId, 1);
  return buf;
}

export function encodeAbort(requestId: Uint8Array, message: string): Buffer {
  const msgBuf = Buffer.from(message, 'utf-8');
  const buf = Buffer.alloc(1 + REQUEST_ID_SIZE + msgBuf.length);
  buf[0] = MessageType.ABORT;
  buf.set(requestId, 1);
  buf.set(msgBuf, 1 + REQUEST_ID_SIZE);
  return buf;
}

export function encodeAck(requestId: Uint8Array, windowBytes: number): Buffer {
  const buf = Buffer.alloc(1 + REQUEST_ID_SIZE + 4);
  buf[0] = MessageType.ACK;
  buf.set(requestId, 1);
  buf.writeUInt32BE(windowBytes, 1 + REQUEST_ID_SIZE);
  return buf;
}

export function encodePing(): Buffer {
  return Buffer.from([MessageType.PING]);
}

export function encodePong(): Buffer {
  return Buffer.from([MessageType.PONG]);
}

// --- Decode ---

export function decodeFrame(data: Uint8Array): DecodedFrame {
  const buf = Buffer.from(data);
  const type = buf[0] as MessageType;

  switch (type) {
    case MessageType.REQUEST_START: {
      let offset = 1;
      const requestId = new Uint8Array(buf.subarray(offset, offset + REQUEST_ID_SIZE));
      offset += REQUEST_ID_SIZE;

      const { value: method, nextOffset: o1 } = readString32BE(buf, offset);
      const { value: url, nextOffset: o2 } = readString32BE(buf, o1);
      const { value: headersJson, nextOffset: o3 } = readString32BE(buf, o2);
      const headers = JSON.parse(headersJson) as Record<string, string>;

      return { type, requestId, method, url, headers };
    }

    case MessageType.REQUEST_CHUNK: {
      const requestId = new Uint8Array(buf.subarray(1, 1 + REQUEST_ID_SIZE));
      const chunkData = new Uint8Array(buf.subarray(1 + REQUEST_ID_SIZE));
      return { type, requestId, data: chunkData };
    }

    case MessageType.REQUEST_END: {
      const requestId = new Uint8Array(buf.subarray(1, 1 + REQUEST_ID_SIZE));
      return { type, requestId };
    }

    case MessageType.RESPONSE_START: {
      let offset = 1;
      const requestId = new Uint8Array(buf.subarray(offset, offset + REQUEST_ID_SIZE));
      offset += REQUEST_ID_SIZE;

      const status = buf.readUInt16BE(offset);
      offset += 2;

      const { value: headersJson } = readString32BE(buf, offset);
      const headers = JSON.parse(headersJson) as Record<string, string>;

      return { type, requestId, status, headers };
    }

    case MessageType.RESPONSE_CHUNK: {
      const requestId = new Uint8Array(buf.subarray(1, 1 + REQUEST_ID_SIZE));
      const chunkData = new Uint8Array(buf.subarray(1 + REQUEST_ID_SIZE));
      return { type, requestId, data: chunkData };
    }

    case MessageType.RESPONSE_END: {
      const requestId = new Uint8Array(buf.subarray(1, 1 + REQUEST_ID_SIZE));
      return { type, requestId };
    }

    case MessageType.ABORT: {
      const requestId = new Uint8Array(buf.subarray(1, 1 + REQUEST_ID_SIZE));
      const errorMessage = buf.toString('utf-8', 1 + REQUEST_ID_SIZE);
      return { type, requestId, errorMessage };
    }

    case MessageType.ACK: {
      const requestId = new Uint8Array(buf.subarray(1, 1 + REQUEST_ID_SIZE));
      const windowBytes = buf.readUInt32BE(1 + REQUEST_ID_SIZE);
      return { type, requestId, windowBytes };
    }

    case MessageType.PING:
      return { type, requestId: new Uint8Array(0) };

    case MessageType.PONG:
      return { type, requestId: new Uint8Array(0) };

    default:
      throw new Error(`Unknown message type: 0x${type.toString(16).padStart(2, '0')}`);
  }
}

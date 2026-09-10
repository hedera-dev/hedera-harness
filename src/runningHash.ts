import crypto from "node:crypto";

const sha384 = (b: Buffer): Buffer => crypto.createHash("sha384").update(b).digest();

const i64 = (v: string | number | bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(v));
  return b;
};

const i32 = (v: string | number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Number(v));
  return b;
};

const STREAM_HEADER = Buffer.from("aced0005", "hex");
const BYTEARRAY_CLASSDESC = Buffer.from("757200025b42acf317f8060854e00200007870", "hex");
const BYTEARRAY_BACKREF = Buffer.from("7571007e0000", "hex");
const blockData = (buf: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0x77, buf.length]), buf]);

export interface RunningHashInput {
  prevRunningHash: Buffer;
  version: number;
  payerAccountId: string;
  topicId: string;
  consensusTimestamp: string;
  sequenceNumber: string | number;
  messageBytes: Buffer;
}

export function nextRunningHash(a: RunningHashInput): Buffer {
  const [ps, pr, pn] = a.payerAccountId.split(".");
  const [ts, tr, tn] = a.topicId.split(".");
  const [secs, nanosRaw] = a.consensusTimestamp.split(".");
  const nanos = (nanosRaw ?? "").padEnd(9, "0");

  const primitives = Buffer.concat([
    i64(a.version),
    i64(ps!), i64(pr!), i64(pn!),
    i64(ts!), i64(tr!), i64(tn!),
    i64(secs!),
    i32(nanos),
    i64(a.sequenceNumber),
  ]);

  return sha384(
    Buffer.concat([
      STREAM_HEADER,
      BYTEARRAY_CLASSDESC, i32(a.prevRunningHash.length), a.prevRunningHash,
      blockData(primitives),
      BYTEARRAY_BACKREF, i32(48), sha384(a.messageBytes),
    ]),
  );
}

export const GENESIS_RUNNING_HASH = Buffer.alloc(48);

export const SUPPORTED_RUNNING_HASH_VERSION = 3;

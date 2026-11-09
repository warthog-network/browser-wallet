import { Buffer } from "buffer";

const MAX_UINT64 = 0xffffffffffffffffn;

/**
 * `buffer` 5.7.1 is what this extension bundles. It has no BigInt writers.
 * warthog-ts encodes fee and amount with `writeBigUInt64BE`.
 */
if (typeof Buffer.prototype.writeBigUInt64BE !== "function") {
  Buffer.prototype.writeBigUInt64BE = function writeBigUInt64BE(
    value: bigint,
    offset = 0,
  ): number {
    if (typeof value !== "bigint") {
      throw new TypeError('The "value" argument must be of type bigint');
    }
    if (value < 0n || value > MAX_UINT64) {
      throw new RangeError('The value of "value" is out of range');
    }
    new DataView(this.buffer, this.byteOffset, this.byteLength).setBigUint64(
      offset,
      value,
      false,
    );
    return offset + 8;
  };
}

export { Buffer };

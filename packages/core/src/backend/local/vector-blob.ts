// SPDX-License-Identifier: Apache-2.0
// The float32 BLOB encoding of `memory_embeddings.embedding`, shared by LocalBackend and the
// knowledge map store. Moved out of local-backend.ts (a tracked hotspot) verbatim.

/** Pack an embedding vector into a float32 BLOB for the `memory_embeddings.embedding` column. */
export function vectorToBlob(vector: number[]): Buffer {
  // new Float32Array(vector) owns a fresh, exactly-sized ArrayBuffer (offset 0).
  return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * Read a float32 BLOB back as a vector. Returns null when the byte length isn't a
 * whole number of float32s or doesn't match the row's declared `dims` (a truncated /
 * hand-corrupted store) so the caller can skip it instead of scoring garbage.
 */
export function blobToVector(blob: Buffer, dims: number): Float32Array | null {
  if (blob.byteLength !== dims * 4) return null;
  // View the exact bytes: a Node Buffer can be a slice of a larger pooled ArrayBuffer.
  return new Float32Array(blob.buffer, blob.byteOffset, dims);
}

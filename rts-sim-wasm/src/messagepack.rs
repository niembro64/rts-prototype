// Hand-rolled MessagePack encoder (Phase 10 D.2) — extracted from lib.rs.

#![allow(clippy::module_inception)]

use std::cell::UnsafeCell;
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Phase 10 D.2 — Hand-rolled MessagePack encoder
//
//  Foundation building block for the future snapshot-serializer
//  port. Encodes the exact subset of MessagePack used by
//  @msgpack/msgpack with `ignoreUndefined: true` (the encoder
//  settings in snapshotWireCodec.ts):
//    - nil (0xC0), false (0xC2), true (0xC3)
//    - positive fixint, negative fixint
//    - uint8/16/32, int8/16/32, int64 (only emitted when value
//      doesn't fit a smaller representation — same as the JS lib)
//    - float32, float64 (we always emit f64 to match JS Number
//      semantics; the JS lib does the same)
//    - fixstr, str8/16/32 (UTF-8 byte length)
//    - fixarray, array16, array32
//    - fixmap, map16, map32
//    - bin8/16/32 (for Uint8Array payloads)
//
//  The encoder writes into a caller-owned Vec<u8>. Subsequent
//  Phase 10 sub-commits will plumb this into a per-recipient
//  snapshot build that produces the final WebRTC bytes in one
//  WASM call.
//
//  Self-test: messagepack_self_test() runs a battery of known-
//  output encodings and returns 0 on pass, a bitmask of failed
//  test ids otherwise. Called once at module load by JS-side
//  initSimWasm so any encoder regression surfaces immediately.
// ─────────────────────────────────────────────────────────────────

pub(crate) struct MessagePackWriter {
    pub(crate) buf: Vec<u8>,
}

impl MessagePackWriter {
    #[allow(dead_code)]
    pub(crate) fn new() -> Self {
        Self {
            buf: Vec::with_capacity(64),
        }
    }

    pub(crate) fn with_capacity(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap),
        }
    }

    pub(crate) fn clear(&mut self) {
        self.buf.clear();
    }

    pub(crate) fn as_slice(&self) -> &[u8] {
        &self.buf
    }

    pub(crate) fn len(&self) -> usize {
        self.buf.len()
    }

    pub(crate) fn write_nil(&mut self) {
        self.buf.push(0xC0);
    }

    pub(crate) fn write_bool(&mut self, v: bool) {
        self.buf.push(if v { 0xC3 } else { 0xC2 });
    }

    /// JS Number → MessagePack. Mirrors the integer-detection branch
    /// in @msgpack/msgpack: if the value is a finite integer in
    /// [INT64_MIN, UINT64_MAX], emit the smallest int encoding; else
    /// emit float64. JS doesn't distinguish Int from Float at runtime
    /// so we have to inspect the value.
    pub(crate) fn write_number(&mut self, v: f64) {
        if !v.is_finite() {
            self.write_f64(v);
            return;
        }
        // Integer if v fits exactly in i64/u64 AND has no fractional
        // part. JS msgpack treats `1.0` as an integer.
        if v.fract() == 0.0
            && v >= -9_223_372_036_854_775_808.0
            && v <= 18_446_744_073_709_551_615.0
        {
            // Use u64 path for non-negative >= 2^63 (above i64 range).
            if v >= 0.0 {
                let u = v as u64;
                self.write_uint(u);
                return;
            }
            let i = v as i64;
            self.write_int(i);
            return;
        }
        self.write_f64(v);
    }

    pub(crate) fn write_uint(&mut self, v: u64) {
        if v < 128 {
            // positive fixint
            self.buf.push(v as u8);
        } else if v <= 0xFF {
            self.buf.push(0xCC);
            self.buf.push(v as u8);
        } else if v <= 0xFFFF {
            self.buf.push(0xCD);
            self.buf.extend_from_slice(&(v as u16).to_be_bytes());
        } else if v <= 0xFFFF_FFFF {
            self.buf.push(0xCE);
            self.buf.extend_from_slice(&(v as u32).to_be_bytes());
        } else {
            self.buf.push(0xCF);
            self.buf.extend_from_slice(&v.to_be_bytes());
        }
    }

    pub(crate) fn write_int(&mut self, v: i64) {
        if v >= 0 {
            self.write_uint(v as u64);
            return;
        }
        if v >= -32 {
            // negative fixint
            self.buf.push((v as i8) as u8);
        } else if v >= -128 {
            self.buf.push(0xD0);
            self.buf.push((v as i8) as u8);
        } else if v >= -32_768 {
            self.buf.push(0xD1);
            self.buf.extend_from_slice(&(v as i16).to_be_bytes());
        } else if v >= -2_147_483_648 {
            self.buf.push(0xD2);
            self.buf.extend_from_slice(&(v as i32).to_be_bytes());
        } else {
            self.buf.push(0xD3);
            self.buf.extend_from_slice(&v.to_be_bytes());
        }
    }

    pub(crate) fn write_f64(&mut self, v: f64) {
        self.buf.push(0xCB);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    #[allow(dead_code)]
    pub(crate) fn write_f32(&mut self, v: f32) {
        self.buf.push(0xCA);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    pub(crate) fn write_str(&mut self, s: &str) {
        let bytes = s.as_bytes();
        let len = bytes.len();
        if len < 32 {
            self.buf.push(0xA0 | len as u8);
        } else if len <= 0xFF {
            self.buf.push(0xD9);
            self.buf.push(len as u8);
        } else if len <= 0xFFFF {
            self.buf.push(0xDA);
            self.buf.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            self.buf.push(0xDB);
            self.buf.extend_from_slice(&(len as u32).to_be_bytes());
        }
        self.buf.extend_from_slice(bytes);
    }

    pub(crate) fn write_array_header(&mut self, n: usize) {
        if n < 16 {
            self.buf.push(0x90 | n as u8);
        } else if n <= 0xFFFF {
            self.buf.push(0xDC);
            self.buf.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            self.buf.push(0xDD);
            self.buf.extend_from_slice(&(n as u32).to_be_bytes());
        }
    }

    pub(crate) fn write_map_header(&mut self, n: usize) {
        if n < 16 {
            self.buf.push(0x80 | n as u8);
        } else if n <= 0xFFFF {
            self.buf.push(0xDE);
            self.buf.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            self.buf.push(0xDF);
            self.buf.extend_from_slice(&(n as u32).to_be_bytes());
        }
    }

    #[allow(dead_code)]
    pub(crate) fn write_bin(&mut self, bytes: &[u8]) {
        let len = bytes.len();
        if len <= 0xFF {
            self.buf.push(0xC4);
            self.buf.push(len as u8);
        } else if len <= 0xFFFF {
            self.buf.push(0xC5);
            self.buf.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            self.buf.push(0xC6);
            self.buf.extend_from_slice(&(len as u32).to_be_bytes());
        }
        self.buf.extend_from_slice(bytes);
    }

    pub(crate) fn append_raw_value(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }
}

// Module-scope writer reused by the self-test + future encoders.
pub(crate) struct MessagePackHolder(UnsafeCell<Option<MessagePackWriter>>);
unsafe impl Sync for MessagePackHolder {}
pub(crate) static MESSAGEPACK_WRITER: MessagePackHolder = MessagePackHolder(UnsafeCell::new(None));

#[inline]
pub(crate) fn messagepack_writer() -> &'static mut MessagePackWriter {
    unsafe {
        let cell = &mut *MESSAGEPACK_WRITER.0.get();
        if cell.is_none() {
            *cell = Some(MessagePackWriter::with_capacity(4096));
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn messagepack_writer_ptr() -> *const u8 {
    messagepack_writer().buf.as_ptr()
}

#[wasm_bindgen]
pub fn messagepack_writer_len() -> u32 {
    messagepack_writer().len() as u32
}

#[wasm_bindgen]
pub fn messagepack_writer_clear() {
    messagepack_writer().clear();
}

#[wasm_bindgen]
pub fn messagepack_writer_append_raw_value(bytes: &[u8]) -> u32 {
    let w = messagepack_writer();
    w.append_raw_value(bytes);
    w.buf.len() as u32
}

/// Run a battery of known-output encodings. Returns 0 if every case
/// passes, otherwise a 32-bit bitmask where bit N is set for case N.
/// Called once by JS at module load so an encoder regression
/// surfaces before Phase 10 ever ships a snapshot.
#[wasm_bindgen]
pub fn messagepack_self_test() -> u32 {
    let mut failures: u32 = 0;

    pub(crate) fn check(w: &mut MessagePackWriter, expected: &[u8], case: u32) -> bool {
        let got = w.as_slice();
        let ok = got == expected;
        w.clear();
        if !ok {
            // (rust) keep a marker for future debug logging.
        }
        let _ = case;
        ok
    }

    let mut w = MessagePackWriter::with_capacity(64);

    // case 0: nil
    w.write_nil();
    if !check(&mut w, &[0xC0], 0) {
        failures |= 1 << 0;
    }

    // case 1: true / false
    w.write_bool(true);
    w.write_bool(false);
    if !check(&mut w, &[0xC3, 0xC2], 1) {
        failures |= 1 << 1;
    }

    // case 2: positive fixint 0, 127
    w.write_number(0.0);
    w.write_number(127.0);
    if !check(&mut w, &[0x00, 0x7F], 2) {
        failures |= 1 << 2;
    }

    // case 3: negative fixint -1, -32
    w.write_number(-1.0);
    w.write_number(-32.0);
    if !check(&mut w, &[0xFF, 0xE0], 3) {
        failures |= 1 << 3;
    }

    // case 4: uint8 (128, 255)
    w.write_number(128.0);
    w.write_number(255.0);
    if !check(&mut w, &[0xCC, 0x80, 0xCC, 0xFF], 4) {
        failures |= 1 << 4;
    }

    // case 5: uint16 (256, 65535)
    w.write_number(256.0);
    w.write_number(65535.0);
    if !check(&mut w, &[0xCD, 0x01, 0x00, 0xCD, 0xFF, 0xFF], 5) {
        failures |= 1 << 5;
    }

    // case 6: uint32 (65536, 4294967295)
    w.write_number(65536.0);
    w.write_number(4_294_967_295.0);
    if !check(
        &mut w,
        &[0xCE, 0x00, 0x01, 0x00, 0x00, 0xCE, 0xFF, 0xFF, 0xFF, 0xFF],
        6,
    ) {
        failures |= 1 << 6;
    }

    // case 7: int8 (-33, -128)
    w.write_number(-33.0);
    w.write_number(-128.0);
    if !check(&mut w, &[0xD0, 0xDF, 0xD0, 0x80], 7) {
        failures |= 1 << 7;
    }

    // case 8: int16 (-129, -32768)
    w.write_number(-129.0);
    w.write_number(-32768.0);
    if !check(&mut w, &[0xD1, 0xFF, 0x7F, 0xD1, 0x80, 0x00], 8) {
        failures |= 1 << 8;
    }

    // case 9: int32 (-32769, -2147483648)
    w.write_number(-32769.0);
    w.write_number(-2_147_483_648.0);
    if !check(
        &mut w,
        &[0xD2, 0xFF, 0xFF, 0x7F, 0xFF, 0xD2, 0x80, 0x00, 0x00, 0x00],
        9,
    ) {
        failures |= 1 << 9;
    }

    // case 10: float64 0.5 (non-integer)
    w.write_number(0.5);
    if !check(
        &mut w,
        &[0xCB, 0x3F, 0xE0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
        10,
    ) {
        failures |= 1 << 10;
    }

    // case 11: float64 NaN (non-finite)
    w.write_number(f64::NAN);
    let bytes = w.as_slice();
    // NaN: 0xCB + 8 bytes whose first byte has bit7 unset/set varies;
    // we just check the marker + length.
    let nan_ok = bytes.len() == 9 && bytes[0] == 0xCB;
    w.clear();
    if !nan_ok {
        failures |= 1 << 11;
    }

    // case 12: fixstr ""
    w.write_str("");
    if !check(&mut w, &[0xA0], 12) {
        failures |= 1 << 12;
    }

    // case 13: fixstr "hi"
    w.write_str("hi");
    if !check(&mut w, &[0xA2, b'h', b'i'], 13) {
        failures |= 1 << 13;
    }

    // case 14: str8 — 32-byte string
    let s32 = "abcdefghijklmnopqrstuvwxyz012345"; // 32 bytes
    w.write_str(s32);
    let bytes = w.as_slice();
    let str8_ok =
        bytes.len() == 34 && bytes[0] == 0xD9 && bytes[1] == 32 && &bytes[2..] == s32.as_bytes();
    w.clear();
    if !str8_ok {
        failures |= 1 << 14;
    }

    // case 15: fixarray with 3 entries
    w.write_array_header(3);
    w.write_number(1.0);
    w.write_number(2.0);
    w.write_number(3.0);
    if !check(&mut w, &[0x93, 0x01, 0x02, 0x03], 15) {
        failures |= 1 << 15;
    }

    // case 16: array16 with 16 entries
    w.write_array_header(16);
    for _ in 0..16 {
        w.write_number(0.0);
    }
    let bytes = w.as_slice();
    let arr16_ok = bytes.len() == 19
        && bytes[0] == 0xDC
        && bytes[1] == 0
        && bytes[2] == 16
        && bytes[3..].iter().all(|&b| b == 0x00);
    w.clear();
    if !arr16_ok {
        failures |= 1 << 16;
    }

    // case 17: fixmap (k:v) "a" → 1
    w.write_map_header(1);
    w.write_str("a");
    w.write_number(1.0);
    if !check(&mut w, &[0x81, 0xA1, b'a', 0x01], 17) {
        failures |= 1 << 17;
    }

    // case 18: empty fixmap, empty fixarray
    w.write_map_header(0);
    w.write_array_header(0);
    if !check(&mut w, &[0x80, 0x90], 18) {
        failures |= 1 << 18;
    }

    // case 19: bin8 — 3 bytes
    w.write_bin(&[0x01, 0x02, 0x03]);
    if !check(&mut w, &[0xC4, 0x03, 0x01, 0x02, 0x03], 19) {
        failures |= 1 << 19;
    }

    // case 20: nested — map { "arr": [1, 2, "hi"] }
    w.write_map_header(1);
    w.write_str("arr");
    w.write_array_header(3);
    w.write_number(1.0);
    w.write_number(2.0);
    w.write_str("hi");
    if !check(
        &mut w,
        &[
            0x81, 0xA3, b'a', b'r', b'r', 0x93, 0x01, 0x02, 0xA2, b'h', b'i',
        ],
        20,
    ) {
        failures |= 1 << 20;
    }

    failures
}

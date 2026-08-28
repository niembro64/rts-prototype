// Battle-scoped liquid presence shared by every authoritative WASM subsystem.
//
// The authored water level remains a terrain-generation datum even when the
// player selects LIQUID = NONE. Runtime medium decisions instead read the
// effective level below: negative infinity makes every finite terrain/body
// position part of the exposed air/ground domain without reshaping the map.

use crate::{WasmGlobal, TERRAIN_WATER_LEVEL};
use wasm_bindgen::prelude::*;

static LIQUID_SURFACE_ENABLED: WasmGlobal<bool> = WasmGlobal::new(true);

#[wasm_bindgen]
pub fn liquid_surface_set_enabled(enabled: bool) {
    *LIQUID_SURFACE_ENABLED.get() = enabled;
}

#[inline]
pub(crate) fn liquid_surface_enabled() -> bool {
    *LIQUID_SURFACE_ENABLED.get()
}

#[inline]
pub(crate) fn liquid_surface_level() -> f64 {
    liquid_surface_level_for_enabled(liquid_surface_enabled())
}

#[inline]
fn liquid_surface_level_for_enabled(enabled: bool) -> f64 {
    if enabled {
        TERRAIN_WATER_LEVEL
    } else {
        f64::NEG_INFINITY
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_liquid_has_no_finite_medium_boundary() {
        assert_eq!(liquid_surface_level_for_enabled(false), f64::NEG_INFINITY);
        assert_eq!(liquid_surface_level_for_enabled(true), TERRAIN_WATER_LEVEL);
    }
}

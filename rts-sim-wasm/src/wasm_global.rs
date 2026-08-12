use core::cell::UnsafeCell;

/// Mutable module-global storage for the single-threaded WASM runtime.
///
/// WebAssembly globals cannot use ordinary Rust synchronization primitives
/// without paying for thread-safety the browser simulation does not enable.
/// Centralizing the unsafe `Sync` contract here keeps every pool and scratch
/// buffer from declaring its own holder type.
///
/// Callers must keep accesses on the simulation thread and must not retain
/// overlapping mutable references. This is the same contract the former
/// per-type `UnsafeCell` holders enforced independently.
pub(crate) struct WasmGlobal<T>(UnsafeCell<T>);

unsafe impl<T> Sync for WasmGlobal<T> {}

impl<T> WasmGlobal<T> {
    pub(crate) const fn new(value: T) -> Self {
        Self(UnsafeCell::new(value))
    }

    #[inline]
    pub(crate) fn get(&'static self) -> &'static mut T {
        // SAFETY: upheld by the single-thread/no-overlapping-borrow contract
        // documented on WasmGlobal.
        unsafe { &mut *self.0.get() }
    }
}

/// Lazily initialized specialization used by the simulation's large pools.
pub(crate) struct WasmLazy<T>(WasmGlobal<Option<T>>);

impl<T> WasmLazy<T> {
    pub(crate) const fn new() -> Self {
        Self(WasmGlobal::new(None))
    }

    #[inline]
    pub(crate) fn get_or_init(&'static self, init: impl FnOnce() -> T) -> &'static mut T {
        self.0.get().get_or_insert_with(init)
    }

    #[inline]
    pub(crate) fn get_initialized(&'static self, message: &str) -> &'static mut T {
        self.0.get().as_mut().expect(message)
    }

    #[inline]
    pub(crate) fn init_if_empty(&'static self, init: impl FnOnce() -> T) {
        let value = self.0.get();
        if value.is_none() {
            *value = Some(init());
        }
    }
}

use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread::{JoinHandle, Thread},
    time::Duration,
};
use wasmtime::Engine;

const EPOCH_TICK_MS: u64 = 10;

/// Drives epoch interruption only while an invocation is running; with no work
/// in flight the ticker thread parks instead of waking on every tick. Shared by
/// the WASM Plugin runtime and the MCP transform runtime.
pub struct EpochTicker {
    active: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Thread,
    /// Taken on drop to join the ticker.
    join: Option<JoinHandle<()>>,
}

/// Counts one running invocation for the ticker, released on drop.
pub struct ActiveInvocation<'a> {
    ticker: &'a EpochTicker,
}

impl Drop for ActiveInvocation<'_> {
    fn drop(&mut self) {
        self.ticker.active.fetch_sub(1, Ordering::Release);
    }
}

impl EpochTicker {
    pub fn new(engine: Engine) -> Self {
        let active = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let join = {
            let active = active.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    if active.load(Ordering::Acquire) == 0 {
                        // An early unpark leaves a token, so no wake is lost.
                        std::thread::park();
                    } else {
                        std::thread::sleep(Duration::from_millis(EPOCH_TICK_MS));
                        engine.increment_epoch();
                    }
                }
            })
        };
        Self {
            active,
            stop,
            thread: join.thread().clone(),
            join: Some(join),
        }
    }

    pub fn begin(&self) -> ActiveInvocation<'_> {
        if self.active.fetch_add(1, Ordering::AcqRel) == 0 {
            self.thread.unpark();
        }
        ActiveInvocation { ticker: self }
    }
}

impl Drop for EpochTicker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.thread.unpark();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

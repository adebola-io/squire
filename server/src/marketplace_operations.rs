//! Desktop-owned marketplace operations. At most [`MAX_ACTIVE`] run at once;
//! the rest wait for a semaphore permit. Plugin commits use the index lock.
use anyhow::{bail, Result};
use serde::Serialize;
use std::{
    collections::VecDeque,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::{broadcast, OwnedSemaphorePermit, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const MAX_RECORDS: usize = 100;
const MAX_LINE_BYTES: usize = 500;
const MAX_ACTIVE: usize = 8;

fn serialize_event(operation: &Operation) -> String {
    serde_json::json!({ "type": "marketplace.operations", "operation": operation }).to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Queued,
    Running,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
}

impl Status {
    fn finished(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub integration_id: String,
    pub status: Status,
    pub phase: String,
    pub percent: Option<u8>,
    pub error: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn bounded(text: &str) -> String {
    let text = text.trim();
    let mut limit = text.len().min(MAX_LINE_BYTES);
    while !text.is_char_boundary(limit) {
        limit -= 1;
    }
    text[..limit].to_owned()
}

struct Record {
    operation: Operation,
    cancellation: CancellationToken,
}

#[derive(Default)]
struct Inner {
    records: VecDeque<Record>,
    stopping: bool,
}

pub struct Operations {
    inner: Mutex<Inner>,
    slots: Arc<Semaphore>,
    events: broadcast::Sender<Arc<str>>,
    tasks: TaskTracker,
}

#[derive(Clone)]
pub struct OperationContext {
    manager: Arc<Operations>,
    id: String,
    pub cancellation: CancellationToken,
}

impl OperationContext {
    pub fn progress(&self, phase: &str, percent: Option<u8>) {
        self.manager.update(&self.id, |op| {
            if op.status != Status::Running {
                return false;
            }
            op.phase = bounded(phase);
            op.percent = percent.map(|value| value.min(100));
            true
        });
    }
}

impl Operations {
    pub fn new(events: broadcast::Sender<Arc<str>>) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            slots: Arc::new(Semaphore::new(MAX_ACTIVE)),
            events,
            tasks: TaskTracker::new(),
        }
    }

    fn emit(&self, operation: &Operation) {
        if self.events.receiver_count() > 0 {
            let _ = self.events.send(Arc::from(serialize_event(operation)));
        }
    }

    /// Applies `change` to a record and emits it when `change` reports a change.
    fn update(&self, id: &str, change: impl FnOnce(&mut Operation) -> bool) {
        let mut inner = self.inner.lock().expect("marketplace operations");
        if let Some(record) = inner.records.iter_mut().find(|r| r.operation.id == id) {
            if change(&mut record.operation) {
                self.emit(&record.operation);
            }
        }
    }

    pub fn enqueue<F, Fut>(self: &Arc<Self>, integration_id: String, work: F) -> Result<Operation>
    where
        F: FnOnce(OperationContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let id = uuid::Uuid::new_v4().to_string();
        let cancellation = CancellationToken::new();
        let operation = {
            let mut inner = self.inner.lock().expect("marketplace operations");
            if inner.stopping {
                bail!("Squire is shutting down");
            }
            if inner.records.iter().any(|r| {
                r.operation.integration_id == integration_id && !r.operation.status.finished()
            }) {
                bail!("An installation is already pending for this plugin");
            }
            while inner.records.len() >= MAX_RECORDS {
                let Some(position) = inner
                    .records
                    .iter()
                    .position(|r| r.operation.status.finished())
                else {
                    bail!("Marketplace operation queue is full");
                };
                inner.records.remove(position);
            }
            // A free slot starts the work immediately, so it never flickers through "queued".
            let permit = self.slots.clone().try_acquire_owned().ok();
            let operation = Operation {
                id: id.clone(),
                integration_id,
                status: if permit.is_some() {
                    Status::Running
                } else {
                    Status::Queued
                },
                phase: if permit.is_some() {
                    "Starting"
                } else {
                    "Queued"
                }
                .into(),
                percent: None,
                error: None,
                created_at: now(),
                finished_at: None,
            };
            inner.records.push_back(Record {
                operation: operation.clone(),
                cancellation: cancellation.clone(),
            });
            self.emit(&operation);
            self.spawn(id, cancellation, permit, work);
            operation
        };
        Ok(operation)
    }

    fn spawn<F, Fut>(
        self: &Arc<Self>,
        id: String,
        token: CancellationToken,
        permit: Option<OwnedSemaphorePermit>,
        work: F,
    ) where
        F: FnOnce(OperationContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let manager = self.clone();
        self.tasks.spawn(async move {
            let _permit = match permit {
                Some(permit) => permit,
                None => {
                    // Queued: cancellation (or shutdown) already marked the record.
                    let acquired = tokio::select! {
                        permit = manager.slots.clone().acquire_owned() => permit.ok(),
                        _ = token.cancelled() => None,
                    };
                    let Some(permit) = acquired else { return };
                    let mut started = false;
                    manager.update(&id, |op| {
                        started = op.status == Status::Queued;
                        if started {
                            op.status = Status::Running;
                            op.phase = "Starting".into();
                        }
                        started
                    });
                    if !started {
                        return;
                    }
                    permit
                }
            };
            let context = OperationContext {
                manager: manager.clone(),
                id: id.clone(),
                cancellation: token.clone(),
            };
            // A panicking installer is a failed operation, not a missing record.
            let result = tokio::spawn(work(context)).await;
            manager.update(&id, |op| {
                op.finished_at = Some(now());
                op.error = match &result {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(bounded(&format!("{error:#}"))),
                    Err(error) => Some(bounded(&error.to_string())),
                };
                (op.status, op.phase) = if op.error.is_none() {
                    op.percent = Some(100);
                    (Status::Succeeded, "Completed".into())
                } else if token.is_cancelled() {
                    (Status::Cancelled, "Cancelled".into())
                } else {
                    (Status::Failed, "Failed".into())
                };
                true
            });
        });
    }

    pub fn list(&self) -> Vec<Operation> {
        self.inner
            .lock()
            .expect("marketplace operations")
            .records
            .iter()
            .map(|r| r.operation.clone())
            .collect()
    }

    /// Queued work is cancelled outright; running work is asked to stop.
    fn request_cancel(record: &mut Record) -> bool {
        let op = &mut record.operation;
        match op.status {
            Status::Queued => {
                op.status = Status::Cancelled;
                op.phase = "Cancelled".into();
                op.finished_at = Some(now());
            }
            Status::Running => {
                op.status = Status::Cancelling;
                op.phase = "Cancelling".into();
            }
            _ => return false,
        }
        record.cancellation.cancel();
        true
    }

    pub fn cancel(&self, id: &str) -> Option<Operation> {
        let mut inner = self.inner.lock().expect("marketplace operations");
        let record = inner.records.iter_mut().find(|r| r.operation.id == id)?;
        if Self::request_cancel(record) {
            self.emit(&record.operation);
        }
        Some(record.operation.clone())
    }

    pub async fn shutdown(&self) {
        {
            let mut inner = self.inner.lock().expect("marketplace operations");
            inner.stopping = true;
            for record in &mut inner.records {
                if Self::request_cancel(record) {
                    self.emit(&record.operation);
                }
            }
            self.tasks.close();
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), self.tasks.wait()).await;
    }
}

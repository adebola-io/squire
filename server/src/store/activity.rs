//! Durable foreground facts and a bounded recent-gap estimate for Connection Threads.
//! Called only from the serialized tool-call write path, never during a list read.
use anyhow::Result;
use rusqlite::{params, Transaction};

const EPISODE_BREAK_MS: i64 = 5 * 60_000;
const FALLBACK_MS: i64 = 60_000;
const MIN_GRACE_MS: i64 = 45_000;
const MAX_GRACE_MS: i64 = 180_000;
const MAX_GAPS: usize = 12;

/// A new call begins or joins a foreground batch. Only gaps between distinct
/// non-overlapping batches of ordinary calls can change the estimate.
pub fn started(tx: &Transaction<'_>, thread: i64, tool: &str, at: i64) -> Result<()> {
    let (running, last_end, last_ordinary, gaps_json): (i64, Option<i64>, bool, String) = tx
        .query_row(
            "SELECT foreground_count, last_foreground_end_at,
                    last_batch_had_ordinary, recent_foreground_gaps
             FROM threads WHERE id=?1",
            [thread],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let ordinary = tool != "start_thread";
    if running > 0 {
        tx.execute(
            "UPDATE threads SET foreground_count=foreground_count+1,
                current_batch_has_ordinary=current_batch_has_ordinary OR ?2,
                last_foreground_started_at=MAX(last_foreground_started_at,?3)
             WHERE id=?1",
            params![thread, ordinary, at],
        )?;
        return Ok(());
    }

    let mut gaps: Vec<i64> = serde_json::from_str(&gaps_json)?;
    if let Some(end) = last_end {
        let gap = at - end;
        if gap > EPISODE_BREAK_MS {
            gaps.clear();
        } else if ordinary && last_ordinary && gap > 0 {
            gaps.push(gap);
            if gaps.len() > MAX_GAPS {
                gaps.remove(0);
            }
        }
    }
    let grace = if gaps.len() < 3 {
        FALLBACK_MS
    } else {
        let mut ranked = gaps.clone();
        ranked.sort_unstable();
        let p75 = ranked[(ranked.len() * 3).div_ceil(4) - 1];
        (p75 * 3 / 2).clamp(MIN_GRACE_MS, MAX_GRACE_MS)
    };
    tx.execute(
        "UPDATE threads SET foreground_count=1,
            last_foreground_started_at=?2, current_batch_has_ordinary=?3,
            recent_foreground_gaps=?4, foreground_grace_ms=?5
         WHERE id=?1",
        params![thread, at, ordinary, serde_json::to_string(&gaps)?, grace],
    )?;
    Ok(())
}

/// One foreground interval ended, either because its call returned or because
/// it was promoted. A batch ends only after its final foreground call leaves.
pub fn ended(tx: &Transaction<'_>, thread: i64, at: i64) -> Result<()> {
    tx.execute(
        "UPDATE threads SET
            foreground_count=MAX(0, foreground_count-1),
            last_foreground_end_at=CASE WHEN foreground_count=1 THEN ?2
                                       ELSE last_foreground_end_at END,
            last_batch_had_ordinary=CASE WHEN foreground_count=1
                                         THEN current_batch_has_ordinary
                                         ELSE last_batch_had_ordinary END,
            current_batch_has_ordinary=CASE WHEN foreground_count=1 THEN 0
                                            ELSE current_batch_has_ordinary END
         WHERE id=?1 AND foreground_count>0",
        params![thread, at],
    )?;
    Ok(())
}

//! Consume the hand component's canonical JSON observer; no duplicate wire ABI.
use super::{telemetry::Telemetry, util::*};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::Read,
    os::fd::AsRawFd,
    process::{Command, Stdio},
    sync::{atomic::Ordering, Arc},
};
#[derive(Default)]
pub struct Hands {
    packet: Value,
    connected: bool,
    observed: u64,
    error: &'static str,
    samples: VecDeque<(u64, u64)>,
}
impl Hands {
    pub fn snapshot(&self, live: bool) -> Value {
        let t = clock(libc::CLOCK_BOOTTIME);
        let p = &self.packet;
        let exposure = number(&p["exposure_boottime_ns"]);
        let decoded = number(&p["decoded_boottime_ns"]);
        let until = number(&p["valid_until_boottime_ns"]);
        let fresh_ = live
            && self.connected
            && p["source"] == "live"
            && fresh(self.observed, now(), 250_000_000)
            && fresh(decoded, t, 250_000_000)
            && exposure > 0
            && exposure <= t
            && t < until;
        let status = if !live {
            "offline"
        } else if !self.connected {
            if self.error.is_empty() {
                "waiting"
            } else {
                self.error
            }
        } else if p["source"] != "live" {
            "replay"
        } else if !fresh_ {
            "stale"
        } else {
            "streaming"
        };
        let hands=(0..2).map(|i|{let v=&p["hands"][i];let valid=fresh_&&v["valid"]==true;json!({"hand":if i==0{"left"}else{"right"},"valid":valid,"detected":v["valid"]==true,"state":if valid{"tracking"}else if fresh_{"no_hand"}else{"unavailable"},"pinch":if valid{v["pinch"].clone()}else{json!(0)},"grab":if valid{v["grab"].clone()}else{json!(0)},"pinching":valid&&(number(&v["flags"])&2)!=0,"grabbing":valid&&(number(&v["flags"])&4)!=0,"grip":if valid{v["grip"].clone()}else{Value::Null},"aim":if valid{v["aim"].clone()}else{Value::Null},"landmarks":if valid{v["landmarks"].clone()}else{Value::Null}})}).collect::<Vec<_>>();
        let hz = if fresh_ {
            self.samples
                .front()
                .zip(self.samples.back())
                .filter(|(a, b)| b.0 > a.0 && b.1 >= a.1)
                .map(|(a, b)| {
                    self.samples.len().saturating_sub(1) as f64 * 1e9 / (b.0 - a.0) as f64
                })
        } else {
            None
        };
        json!({"status":status,"connected":self.connected,"fresh":fresh_,"source":p["source"],"sequence":p["sequence"],"producer_pid":p["producer_pid"],"age_ms":age(exposure,t),"observer_age_ms":age(self.observed,now()),"exposure_to_publication_ms":if decoded>=exposure&&exposure>0{json!((decoded-exposure)as f64/1e6)}else{Value::Null},"valid_for_ms":if fresh_{json!(until.saturating_sub(t)as f64/1e6)}else{json!(0)},"packet_hz":hz,"model_landmark_count":21,"openxr_joint_count":26,"joint_source":"model landmarks; five OpenXR metacarpals are anatomical estimates","coordinate_space":"raw OpenVR driver world, before recenter","hands":hands,"read_only":true})
    }
}
pub fn observe(a: Arc<Telemetry>) {
    while !stopped() {
        if !fresh(a.requested.load(Ordering::Relaxed), now(), 10_000_000_000) {
            pause(250);
            continue;
        }
        let mut cmd = Command::new("/usr/bin/xr-hand-status");
        cmd.arg("--follow")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        user_child(&mut cmd);
        let Ok(mut child) = cmd.spawn() else {
            a.hands.lock().unwrap().error = "observer_unavailable";
            pause(1000);
            continue;
        };
        let mut pipe = child.stdout.take().unwrap();
        let mut pending = Vec::new();
        while !stopped() && fresh(a.requested.load(Ordering::Relaxed), now(), 10_000_000_000) {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            if !readable(pipe.as_raw_fd(), 100) {
                continue;
            }
            let mut buf = [0; 16384];
            let Ok(n) = pipe.read(&mut buf) else {
                break;
            };
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            if pending.len() > 65536 {
                break;
            }
            while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                let line = pending.drain(..=end).collect::<Vec<_>>();
                let Ok(p) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                if p["observer_schema"] != 1
                    || p["hands"].as_array().is_none_or(|h| h.len() != 2)
                    || number(&p["decoded_boottime_ns"]) == 0
                {
                    continue;
                }
                let t = now();
                let seq = number(&p["sequence"]);
                let mut h = a.hands.lock().unwrap();
                if h.packet["producer_pid"] != p["producer_pid"]
                    || number(&h.packet["sequence"]) > seq
                {
                    h.samples.clear();
                }
                let duplicate = h.packet["producer_pid"] == p["producer_pid"]
                    && number(&h.packet["sequence"]) == seq;
                if !duplicate && h.samples.len() == 64 {
                    h.samples.pop_front();
                }
                if !duplicate {
                    h.samples.push_back((t, seq));
                }
                h.packet = p;
                h.observed = t;
                h.connected = true;
                h.error = "";
            }
        }
        stop_child(&mut child, true);
        let mut h = a.hands.lock().unwrap();
        h.connected = false;
        h.error = "disconnected";
        drop(h);
        pause(500);
    }
}

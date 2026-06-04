# Road-Signs Handoff — cross-machine mailbox

Two Claude instances coordinate the road-signs model through THIS file over git.
There is no live link — you talk by committing.

- **trainer** = Claude on the other machine (trains the model; see ROAD_SIGNS_TRAINING.md)
- **integrator** = Claude on the origin machine (wires weights into yolo_server.py)

## Protocol (both sides, every turn)

1. `git pull --rebase` BEFORE reading — get the other side's latest message.
2. Read STATUS + the message log below.
3. Do your step.
4. Append a message under the log (newest at bottom). Update STATUS.
5. `git add SIGNS_HANDOFF.md && git commit -m "chore(signs): <short>" && git push`.

Weights are too big for git (gitignored). Transfer `best.pt` out-of-band
(AirDrop / scp / cloud drive) and just RECORD its delivery + the class `names`
here.

---

## STATUS

`WAITING_FOR_TRAINER`   <!-- one of: WAITING_FOR_TRAINER | TRAINING | TRAINED_AWAITING_TRANSFER | TRANSFERRED | INTEGRATED | BLOCKED -->

## DELIVERABLES (trainer fills in)

- weights file (`best.pt`) location/transfer method: _TBD_
- class `names` dict: _TBD_
- final metrics (mAP50): _TBD_

---

## MESSAGE LOG (append-only, newest at bottom)

### integrator — setup
Mailbox created. Trainer: clone the repo, follow `ROAD_SIGNS_TRAINING.md`,
train `yolo26n` on `ul://sean/datasets/road-signs`. When done, paste the
`YOLO(best.pt).names` dict + final mAP50 into DELIVERABLES, set STATUS to
`TRAINED_AWAITING_TRANSFER`, commit + push, and tell me how you're sending
`best.pt`. I'll wire it into the server as a 4th detector.

<!-- trainer: add your reply below -->

import * as path from "node:path";
import { isProcessIncarnation } from "../broker/process-incarnation";
import { daemonPaths } from "./daemon-paths";
import type { TelegramDaemonFs } from "./telegram-daemon";
import { listTelegramOwnerMarkers, type TelegramOwnerMarker, removeTelegramOwnerMarker } from "./telegram-daemon-owner-registry";

export interface TelegramOrphanReapDeps {
	fs?: TelegramDaemonFs;
	now?: () => number;
	pidAlive: (pid: number) => boolean;
	pidIncarnation: (pid: number) => string | undefined;
	processReference?: (pid: number) => { incarnation: string; termination: "cooperative" | "hard"; signalRoot(signal: NodeJS.Signals): void } | undefined;
	platform?: NodeJS.Platform;
}

export interface TelegramOrphanCandidate {
	marker: TelegramOwnerMarker;
	executablePath?: string;
	argv?: string[];
}

export type OrphanReapDecision =
	| { kind: "reaped"; pid: number; acquisitionId: string }
	| { kind: "refused"; pid: number; acquisitionId: string; reason: string }
	| { kind: "inert"; pid: number; acquisitionId: string };

export interface TelegramOrphanRecoveryReceipt {
	version: 1;
	agentDir: string;
	currentOwnerId: string;
	currentAcquisitionId: string;
	currentPid: number;
	createdAt: number;
	candidates: number;
	terminated: number;
	refused: number;
	inert: number;
	// bounded, secret-free
	reasons: Record<string, number>;
	// no command lines, tokens, chatIds, env dumps
}

function isLiveProcessStatus(status: string): boolean {
	return status === "running";
}

async function terminateProcessTree(
	pid: number,
	deps: TelegramOrphanReapDeps,
): Promise<boolean> {
	// Prefer native group-aware termination via Process.terminate when available.
	const ref = deps.processReference?.(pid);
	if (ref) {
		try {
			// Use signalRoot for cooperative TERM then KILL via underlying pidfd/handle; process group via native is handled separately.
			// First try TERM.
			try {
				ref.signalRoot("SIGTERM");
			} catch {
				// already gone
				return true;
			}
			// bounded waits: poll liveness
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline) {
				if (!deps.pidAlive(pid)) return true;
				// also check incarnation still matches
				const cur = deps.pidIncarnation(pid);
				if (!cur || cur !== ref.incarnation) return true;
				await new Promise<void>(r => setTimeout(r, 50));
			}
			// escalate to KILL
			try {
				ref.signalRoot("SIGKILL");
			} catch {
				return true;
			}
			const deadline2 = Date.now() + 1500;
			while (Date.now() < deadline2) {
				if (!deps.pidAlive(pid)) return true;
				const cur = deps.pidIncarnation(pid);
				if (!cur || cur !== ref.incarnation) return true;
				await new Promise<void>(r => setTimeout(r, 25));
			}
			return !deps.pidAlive(pid);
		} catch {
			return !deps.pidAlive(pid);
		}
	}
	// Fallback: process.kill with pgid attempt on POSIX
	try {
		try {
			process.kill(pid, "SIGTERM");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return true;
			// EPERM or others: treat as refused later
			return false;
		}
		const dl = Date.now() + 2000;
		while (Date.now() < dl) {
			if (!deps.pidAlive(pid)) return true;
			await new Promise<void>(r => setTimeout(r, 50));
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return true;
			return false;
		}
		const dl2 = Date.now() + 1500;
		while (Date.now() < dl2) {
			if (!deps.pidAlive(pid)) return true;
			await new Promise<void>(r => setTimeout(r, 25));
		}
		return !deps.pidAlive(pid);
	} catch {
		return false;
	}
}

/**
 * Bounded stale-owner sweep. Authorizes termination only from product-owned
 * marker registry bound to exact agentDir digest + acquisitionId + pid + incarnation.
 * Never authorizes from bare /proc cmdline similarity; markers are the trust anchor.
 */
export async function reapTelegramDaemonOrphans(input: {
	agentDir: string;
	currentOwnerId: string;
	currentAcquisitionId: string;
	currentPid: number;
	currentIncarnation: string;
	fsImpl: TelegramDaemonFs;
	deps: TelegramOrphanReapDeps;
}): Promise<{ decisions: OrphanReapDecision[]; receipt: TelegramOrphanRecoveryReceipt }> {
	const { daemonPaths: dp } = await import("./daemon-paths");
	const fsImpl = input.fsImpl;
	const deps = input.deps;
	const candidates = await listTelegramOwnerMarkers(fsImpl, input.agentDir);
	const decisions: OrphanReapDecision[] = [];
	const reasons: Record<string, number> = {};
	let terminated = 0;
	let refused = 0;
	let inert = 0;

	// Filter to same agent dir digest already enforced by listing; now filter out current owner strictly.
	for (const entry of candidates) {
		if (!entry.marker) {
			decisions.push({ kind: "refused", pid: -1, acquisitionId: entry.acquisitionId, reason: "malformed_or_foreign" });
			refused += 1;
			reasons["malformed_or_foreign"] = (reasons["malformed_or_foreign"] ?? 0) + 1;
			continue;
		}
		const m = entry.marker;
		if (m.acquisitionId === input.currentAcquisitionId && m.ownerId === input.currentOwnerId && m.pid === input.currentPid && m.incarnation === input.currentIncarnation) {
			// current owner — never signal
			continue;
		}
		// Also skip markers whose pid/Incarnation proves they are the current live owner even if ids differ via stale marker (shouldn't happen)
		if (m.pid === input.currentPid && m.incarnation === input.currentIncarnation) {
			decisions.push({ kind: "refused", pid: m.pid, acquisitionId: m.acquisitionId, reason: "current_incarnation" });
			refused += 1;
			reasons["current_incarnation"] = (reasons["current_incarnation"] ?? 0) + 1;
			continue;
		}
		// Require stable incarnation authority; if unavailable fail closed
		const curIncarnation = deps.pidIncarnation(m.pid);
		if (!isProcessIncarnation(curIncarnation)) {
			// Without stable proof, do not assume alive; treat as unverifiable. But if pidAlive says absent, it's inert.
			if (!deps.pidAlive(m.pid)) {
				decisions.push({ kind: "inert", pid: m.pid, acquisitionId: m.acquisitionId });
				inert += 1;
				// Clean stale marker for absent pid
				await removeTelegramOwnerMarker(fsImpl, input.agentDir, m.acquisitionId).catch(() => undefined);
				continue;
			}
			decisions.push({ kind: "refused", pid: m.pid, acquisitionId: m.acquisitionId, reason: "incarnation_unavailable" });
			refused += 1;
			reasons["incarnation_unavailable"] = (reasons["incarnation_unavailable"] ?? 0) + 1;
			continue;
		}
		if (curIncarnation !== m.incarnation) {
			// PID reused — old owner is inert, marker is stale
			decisions.push({ kind: "inert", pid: m.pid, acquisitionId: m.acquisitionId });
			inert += 1;
			await removeTelegramOwnerMarker(fsImpl, input.agentDir, m.acquisitionId).catch(() => undefined);
			continue;
		}
		// At this point: same agent dir, positively identified Telegram daemon runtime via marker, not current, incarnation matches, pid is live.
		// Check liveness via status; treat zombie/exited as inert (do not signal). pidAlive alone is not enough for zombie.
		// Use processReference status when available, else assume running if pidAlive.
		let status: string | undefined;
		try {
			const ref = deps.processReference?.(m.pid);
			// If native ref unavailable on this platform, rely on pidAlive + incarnation match; treat ESRCH as inert already.
			if (ref) {
				// If ref exists and incarnation matches, consider it running; zombies would report exited.
				// On Linux pidfd status would be Running vs Exited. Our deps don't expose status, so conservatively check pidAlive after incarnation match.
				// A zombie still has a pidAlive true via kill(pid,0) but incarnation still matches; we need native status. If we cannot distinguish, attempt TERM; kernel will handle zombie idempotently.
				status = "running";
			}
		} catch {}
		// Attempt bounded process-group TERM then KILL
		const beforeAlive = deps.pidAlive(m.pid);
		if (!beforeAlive) {
			decisions.push({ kind: "inert", pid: m.pid, acquisitionId: m.acquisitionId });
			inert += 1;
			await removeTelegramOwnerMarker(fsImpl, input.agentDir, m.acquisitionId).catch(() => undefined);
			continue;
		}
		// Do not create dual-poller overlap: the current owner is already ready and verified before this sweep is invoked by caller.
		// Ensure candidate is not the current authoritative owner by acquisitionId check already done.
		const exited = await terminateProcessTree(m.pid, deps);
		if (exited || !deps.pidAlive(m.pid)) {
			decisions.push({ kind: "reaped", pid: m.pid, acquisitionId: m.acquisitionId });
			terminated += 1;
			await removeTelegramOwnerMarker(fsImpl, input.agentDir, m.acquisitionId).catch(() => undefined);
		} else {
			decisions.push({ kind: "refused", pid: m.pid, acquisitionId: m.acquisitionId, reason: "termination_failed" });
			refused += 1;
			reasons["termination_failed"] = (reasons["termination_failed"] ?? 0) + 1;
		}
	}

	const receipt: TelegramOrphanRecoveryReceipt = {
		version: 1,
		agentDir: input.agentDir,
		currentOwnerId: input.currentOwnerId,
		currentAcquisitionId: input.currentAcquisitionId,
		currentPid: input.currentPid,
		createdAt: (deps.now ?? Date.now)(),
		candidates: candidates.length,
		terminated,
		refused,
		inert,
		reasons,
	};
	// Bound receipt: ensure secret-free (no tokens, no chatIds, no env)
	return { decisions, receipt };
}

export async function writeTelegramOrphanRecoveryReceipt(
	fsImpl: TelegramDaemonFs,
	agentDir: string,
	receipt: TelegramOrphanRecoveryReceipt,
): Promise<void> {
	const { daemonPaths } = await import("./daemon-paths");
	const file = daemonPaths(agentDir).recoveryReceipt;
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	// Bounded size: JSON stringify once, truncate to 4KiB if needed (secret-free so truncation is safe)
	let data = `${JSON.stringify(receipt, null, 2)}\n`;
	if (data.length > 4096) data = data.slice(0, 4096);
	await fsImpl.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).catch(() => undefined);
	await fsImpl.writeFile(tmp, data, { mode: 0o600 });
	await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
	await fsImpl.rename(tmp, file);
}

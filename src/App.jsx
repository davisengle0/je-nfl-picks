import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase, normalizeName } from "./supabase";
import { isLocked, computeLeaderboard, computeMatchupStats } from "./logic";

// Use session storage so you must re-enter password after closing the tab/browser.
const ADMIN_KEY = "je_picks_admin_authed_session";

const ROUND_ORDER = ["Wild Card", "Divisional", "Conference", "Super Bowl"];

function roundSortKey(r) {
  const idx = ROUND_ORDER.indexOf(r);
  if (idx !== -1) return idx;
  return 999;
}

function matchupTitle(m) {
  return `${m.team_a} at ${m.team_b}`;
}

function formatLocalLock(isoUtc) {
  if (!isoUtc) return "Not set";
  try {
    const d = new Date(isoUtc);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); // 7:00 PM
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${month}/${day} ${time}`; // 1/6 7:00 PM
  } catch {
    return "Not set";
  }
}

function safeTrim(s) {
  return (s ?? "").trim();
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [toast, setToast] = useState("");

  const [contest, setContest] = useState(null);

  const [currentMatchups, setCurrentMatchups] = useState([]);
  const [allMatchups, setAllMatchups] = useState([]);

  const [entries, setEntries] = useState([]);
  const [allPicks, setAllPicks] = useState([]);

  const [view, setView] = useState("home"); // home | picks | results | admin
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [me, setMe] = useState(null);

  const [myPicks, setMyPicks] = useState({}); // matchup_id -> 'A' | 'B'

  const locked = useMemo(() => isLocked(contest?.round_lock_utc), [contest?.round_lock_utc]);
  const currentRoundName = contest?.current_round_name || "Current Round";
  const lockText = useMemo(() => formatLocalLock(contest?.round_lock_utc), [contest?.round_lock_utc]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  async function loadAll({ showSpinner = false } = {}) {
    if (showSpinner && !hasLoadedOnce) setLoading(true);

    const c = await supabase
      .from("contests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (c.error) {
      setToast(`Contest load error: ${c.error.message}`);
      if (!hasLoadedOnce) setLoading(false);
      return;
    }

    const contestRow = c.data;
    setContest(contestRow);

    const allM = await supabase
      .from("matchups")
      .select("*")
      .eq("contest_id", contestRow.id)
      .order("round_name", { ascending: true })
      .order("game_order", { ascending: true });

    if (allM.error) setToast(`All matchups load error: ${allM.error.message}`);

    const allMatchupsRows = allM.data || [];
    setAllMatchups(allMatchupsRows);

    const curM = allMatchupsRows.filter((m) => m.round_name === contestRow.current_round_name);
    setCurrentMatchups(curM);

    const e = await supabase
      .from("entries")
      .select("*")
      .eq("contest_id", contestRow.id)
      .order("created_at", { ascending: true });

    if (e.error) setToast(`Entries load error: ${e.error.message}`);
    setEntries(e.data || []);

    const p = await supabase.from("picks").select("*").eq("contest_id", contestRow.id);
    if (p.error) setToast(`Picks load error: ${p.error.message}`);
    setAllPicks(p.data || []);

    if (!hasLoadedOnce) {
      setHasLoadedOnce(true);
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll({ showSpinner: true });

    const t = setInterval(() => {
      if (viewRef.current === "admin") return;
      loadAll({ showSpinner: false });
    }, 25000);

    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leaderboard = useMemo(() => {
    return computeLeaderboard(entries, allMatchups, allPicks);
  }, [entries, allMatchups, allPicks]);

  const rounds = useMemo(() => {
    const set = new Set(allMatchups.map((m) => m.round_name));
    if (currentRoundName) set.add(currentRoundName);
    return Array.from(set).sort((a, b) => roundSortKey(a) - roundSortKey(b) || a.localeCompare(b));
  }, [allMatchups, currentRoundName]);

  async function continueWithName() {
    const fnRaw = safeTrim(first);
    const lnRaw = safeTrim(last);

    if (!fnRaw || !lnRaw) {
      setToast("Enter first and last name.");
      return;
    }
    if (!contest) {
      setToast("Contest not loaded yet.");
      return;
    }

    // Case-insensitive identity
    const nk = normalizeName(fnRaw.toLowerCase(), lnRaw.toLowerCase());

    const existing = await supabase
      .from("entries")
      .select("*")
      .eq("contest_id", contest.id)
      .eq("name_key", nk)
      .limit(1)
      .maybeSingle();

    if (existing.error) {
      setToast(`Lookup error: ${existing.error.message}`);
      return;
    }

    let entry = existing.data;

    if (!entry) {
      const ins = await supabase
        .from("entries")
        .insert([
          {
            contest_id: contest.id,
            first_name: fnRaw,
            last_name: lnRaw,
            name_key: nk
          }
        ])
        .select("*")
        .single();

      if (ins.error) {
        setToast(`Create error: ${ins.error.message}`);
        return;
      }
      entry = ins.data;
      await loadAll({ showSpinner: false });
    }

    setMe(entry);

    const mp = await supabase
      .from("picks")
      .select("*")
      .eq("contest_id", contest.id)
      .eq("entry_id", entry.id);

    if (mp.error) {
      setToast(`Your picks error: ${mp.error.message}`);
      return;
    }

    const map = {};
    for (const p of mp.data || []) map[p.matchup_id] = p.picked;
    setMyPicks(map);

    setView("picks");
  }

  async function setPick(matchupId, picked) {
    if (!me || !contest) {
      setToast("Go to Home and enter your name first.");
      return;
    }
    if (locked) {
      setToast("Locked — picks can’t be changed.");
      return;
    }

    setMyPicks((prev) => ({ ...prev, [matchupId]: picked }));

    const up = await supabase
      .from("picks")
      .upsert(
        [
          {
            contest_id: contest.id,
            matchup_id: matchupId,
            entry_id: me.id,
            picked
          }
        ],
        { onConflict: "entry_id,matchup_id" }
      );

    if (up.error) {
      setToast(`Save error: ${up.error.message}`);
      return;
    }

    setToast("Saved");
    await loadAll({ showSpinner: false });
  }

  if (loading && !hasLoadedOnce) {
    return <div style={styles.loading}>Loading…</div>;
  }

  return (
    <div style={styles.page}>
      {toast && <div style={styles.toast}>{toast}</div>}

      <div style={styles.topbar}>
        <div>
          <div style={styles.brand}>JECH NFL Playoff Picks</div>
          <div style={styles.subhead}>
            Current round: <b>{currentRoundName}</b> • Locks: <b>{lockText}</b> •{" "}
            <span style={{ color: locked ? "#b91c1c" : "#166534", fontWeight: 900 }}>
              {locked ? "LOCKED" : "OPEN"}
            </span>
          </div>
        </div>

        <div style={styles.nav}>
          <button style={styles.navBtn} onClick={() => setView("home")}>
            Home
          </button>

          <button
            style={me ? styles.navBtn : styles.navBtnDisabled}
            onClick={() => setView("picks")}
            disabled={!me}
          >
            My Picks
          </button>

          <button style={styles.navBtn} onClick={() => setView("results")}>
            Results
          </button>
        </div>
      </div>

      <div style={styles.container}>
        {view === "home" && (
          <Card>
            <h2 style={styles.h2}>Name</h2>
            <p style={styles.p}>Enter your name to make picks</p>

            <div style={styles.formRow}>
              <div style={styles.field}>
                <div style={styles.label}>First name</div>
                <input style={styles.input} value={first} onChange={(e) => setFirst(e.target.value)} />
              </div>
              <div style={styles.field}>
                <div style={styles.label}>Last name</div>
                <input style={styles.input} value={last} onChange={(e) => setLast(e.target.value)} />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <button style={styles.primaryBtn} onClick={continueWithName}>
                Continue
              </button>
            </div>

            <div style={styles.homeBottomRow}>
              <button style={styles.adminSmallBtn} onClick={() => setView("admin")}>
                Admin
              </button>
            </div>
          </Card>
        )}

        {view === "picks" && (
          <Card>
            {!me ? (
              <div style={styles.p}>Go to Home and enter your name first.</div>
            ) : (
              <>
                <div style={styles.sectionHead}>
                  <div>
                    <div style={styles.sectionKicker}>Your picks</div>
                    <div style={styles.sectionTitle}>
                      {me.first_name} {me.last_name}
                    </div>
                    <div style={styles.p}>
                      Current round: <b>{currentRoundName}</b>
                    </div>
                  </div>
                  <div style={locked ? styles.badgeLocked : styles.badgeOpen}>{locked ? "LOCKED" : "OPEN"}</div>
                </div>

                {currentMatchups.length === 0 ? (
                  <div style={styles.empty}>No games entered yet for the current round.</div>
                ) : (
                  <div style={styles.list}>
                    {currentMatchups.map((m) => {
                      const picked = myPicks[m.id] || null;
                      return (
                        <div key={m.id} style={styles.gameCard}>
                          <div style={styles.gameTop}>
                            <div style={styles.gameTitle}>{matchupTitle(m)}</div>
                          </div>

                          <div style={styles.pickRow}>
                            <PickButton
                              label={m.team_a}
                              active={picked === "A"}
                              onClick={() => setPick(m.id, "A")}
                              disabled={locked}
                            />
                            <PickButton
                              label={m.team_b}
                              active={picked === "B"}
                              onClick={() => setPick(m.id, "B")}
                              disabled={locked}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </Card>
        )}

        {view === "results" && (
          <ResultsHub
            me={me}
            rounds={rounds}
            allMatchups={allMatchups}
            entries={entries}
            allPicks={allPicks}
            leaderboard={leaderboard}
            contest={contest}
            locked={locked}
            currentRoundName={currentRoundName}
          />
        )}

        {view === "admin" && (
          <AdminPanel
            contest={contest}
            rounds={rounds}
            allMatchups={allMatchups}
            entries={entries}
            allPicks={allPicks}
            onUpdated={() => loadAll({ showSpinner: false })}
            setToast={setToast}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- Results Hub ---------------- */

function ResultsHub({ me, rounds, allMatchups, entries, allPicks, leaderboard, contest, locked, currentRoundName }) {
  const [tab, setTab] = useState("leaderboard"); // leaderboard | round | my
  const [selectedRound, setSelectedRound] = useState(currentRoundName || rounds?.[0] || "");

  useEffect(() => {
    if (currentRoundName) setSelectedRound(currentRoundName);
  }, [currentRoundName]);

  useEffect(() => {
    if (!selectedRound && rounds?.length) setSelectedRound(currentRoundName || rounds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds?.length]);

  const matchupsInRound = useMemo(() => {
    return allMatchups
      .filter((m) => m.round_name === selectedRound)
      .sort((a, b) => (a.game_order ?? 0) - (b.game_order ?? 0));
  }, [allMatchups, selectedRound]);

  const hideRoundPickStats = useMemo(() => {
    const isCurrentRound = selectedRound === contest?.current_round_name;
    return isCurrentRound && !locked;
  }, [selectedRound, contest?.current_round_name, locked]);

  return (
    <Card>
      <div style={styles.sectionHead}>
        <div>
          <div style={styles.sectionTitle}>RESULTS</div>
        </div>
      </div>

      <div style={styles.tabs}>
        <button style={tab === "leaderboard" ? styles.tabActive : styles.tab} onClick={() => setTab("leaderboard")}>
          Leaderboard
        </button>
        <button style={tab === "round" ? styles.tabActive : styles.tab} onClick={() => setTab("round")}>
          Round stats
        </button>
        <button style={tab === "my" ? styles.tabActive : styles.tab} onClick={() => setTab("my")}>
          My picks
        </button>
      </div>

      {tab !== "leaderboard" && (
        <div style={{ marginTop: 12 }}>
          <div style={styles.label}>Round</div>
          <select style={styles.select} value={selectedRound} onChange={(e) => setSelectedRound(e.target.value)}>
            {rounds.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        {tab === "leaderboard" && <Leaderboard leaderboard={leaderboard} />}

        {tab === "round" && (
          <RoundStats matchups={matchupsInRound} entries={entries} allPicks={allPicks} hidePickStats={hideRoundPickStats} />
        )}

        {tab === "my" && <MyPicksByRound me={me} matchups={matchupsInRound} allPicks={allPicks} />}
      </div>
    </Card>
  );
}

function RoundStats({ matchups, entries, allPicks, hidePickStats }) {
  if (!matchups.length) return <div style={styles.empty}>No games found for this round yet.</div>;
  if (hidePickStats) return <div style={styles.empty}>Picks are hidden until this round locks.</div>;

  return (
    <div style={styles.list}>
      {matchups.map((m) => {
        const picksForMatchup = allPicks.filter((p) => p.matchup_id === m.id);
        const s = computeMatchupStats(m, entries, picksForMatchup);
        const hasWinner = !!m.winner;

        return (
          <div key={m.id} style={styles.gameCard}>
            <div style={styles.gameTop}>
              <div style={styles.gameTitle}>{matchupTitle(m)}</div>
              {hasWinner ? (
                <div style={styles.winnerPill}>
                  Winner: <b>{m.winner === "A" ? m.team_a : m.team_b}</b>{" "}
                  <span style={{ opacity: 0.8 }}>({m.score_a ?? ""}-{m.score_b ?? ""})</span>
                </div>
              ) : (
                <div style={styles.noWinnerPill}>No result yet</div>
              )}
            </div>

            <div style={styles.statsRow}>
              <StatSide team={m.team_a} pct={s.aPct} count={s.aCount} names={s.aPickers} winning={m.winner === "A"} />
              <StatSide team={m.team_b} pct={s.bPct} count={s.bCount} names={s.bPickers} winning={m.winner === "B"} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MyPicksByRound({ me, matchups, allPicks }) {
  if (!me) return <div style={styles.empty}>Enter your name on Home first.</div>;
  if (!matchups.length) return <div style={styles.empty}>No games found for this round yet.</div>;

  const my = allPicks.filter((p) => p.entry_id === me.id);
  const pickByMatchup = new Map(my.map((p) => [p.matchup_id, p.picked]));

  return (
    <div style={styles.list}>
      {matchups.map((m) => {
        const pickedSide = pickByMatchup.get(m.id);
        const pickedTeam = pickedSide ? (pickedSide === "A" ? m.team_a : m.team_b) : "(no pick)";
        const hasWinner = !!m.winner;
        const correct = hasWinner ? pickedSide === m.winner : null;

        return (
          <div key={m.id} style={styles.gameCard}>
            <div style={styles.gameTop}>
              <div style={styles.gameTitle}>{matchupTitle(m)}</div>
              {hasWinner ? (
                <div style={styles.winnerPill}>
                  Winner: <b>{m.winner === "A" ? m.team_a : m.team_b}</b>{" "}
                  <span style={{ opacity: 0.8 }}>({m.score_a ?? ""}-{m.score_b ?? ""})</span>
                </div>
              ) : (
                <div style={styles.noWinnerPill}>No result yet</div>
              )}
            </div>

            <div style={styles.p}>
              Your pick: <b>{pickedTeam}</b>
            </div>

            {hasWinner && <div style={correct ? styles.correctLine : styles.incorrectLine}>{correct ? "Correct (+1)" : "Incorrect (+0)"}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Admin Panel ---------------- */

function AdminPanel({ contest, rounds, allMatchups, entries, allPicks, onUpdated, setToast }) {
  // Kill any old “always authed” behavior from prior builds
  useEffect(() => {
    try {
      localStorage.removeItem("je_picks_admin_authed");
      localStorage.removeItem("je_picks_admin_authed_session");
    } catch {
      // ignore
    }
  }, []);

  const [authed, setAuthed] = useState(() => sessionStorage.getItem(ADMIN_KEY) === "1");
  const [pw, setPw] = useState("");

  const [roundName, setRoundName] = useState(contest?.current_round_name || "");
  const [lockLocal, setLockLocal] = useState(contest?.round_lock_utc ? contest.round_lock_utc.slice(0, 16) : "");

  const [manageRound, setManageRound] = useState(contest?.current_round_name || (rounds?.[0] || ""));

  useEffect(() => {
    if (contest?.current_round_name) {
      setManageRound(contest.current_round_name);
      setRoundName(contest.current_round_name);
    }
    if (contest?.round_lock_utc) setLockLocal(contest.round_lock_utc.slice(0, 16));
  }, [contest?.current_round_name, contest?.round_lock_utc]);

  const matchupsInManageRound = useMemo(() => {
    return allMatchups
      .filter((m) => m.round_name === manageRound)
      .sort((a, b) => (a.game_order ?? 0) - (b.game_order ?? 0));
  }, [allMatchups, manageRound]);

  const [rows, setRows] = useState(() => normalizeRows(matchupsInManageRound));
  useEffect(() => {
    setRows(normalizeRows(matchupsInManageRound));
  }, [matchupsInManageRound]);

  function checkPw() {
    const expected = import.meta.env.VITE_ADMIN_PASSWORD || "";
    if (!expected) {
      setToast("Set VITE_ADMIN_PASSWORD in Netlify env vars.");
      return;
    }
    if (pw === expected) {
      sessionStorage.setItem(ADMIN_KEY, "1");
      setAuthed(true);
      setToast("Admin unlocked");
      setPw("");
    } else {
      setToast("Wrong admin password");
    }
  }

  function lockAdmin() {
    sessionStorage.removeItem(ADMIN_KEY);
    setAuthed(false);
    setPw("");
    setToast("Admin locked");
  }

  function updateRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveRoundSettings() {
    if (!contest?.id) {
      setToast("No contest found.");
      return;
    }
    try {
      const up = await supabase
        .from("contests")
        .update({
          current_round_name: roundName,
          round_lock_utc: lockLocal ? new Date(lockLocal).toISOString() : null
        })
        .eq("id", contest.id);

      if (up.error) throw up.error;

      setToast("Saved round settings");
      await onUpdated();
    } catch (e) {
      setToast(`Save error: ${e.message}`);
    }
  }

  async function addGame() {
    if (!contest?.id) {
      setToast("No contest found.");
      return;
    }
    try {
      const nextOrder = (rows.reduce((mx, r) => Math.max(mx, Number(r.game_order) || 0), 0) || 0) + 1;

      const ins = await supabase
        .from("matchups")
        .insert([
          {
            contest_id: contest.id,
            round_name: manageRound,
            game_order: nextOrder,
            label: null,
            team_a: "Team A",
            team_b: "Team B",
            start_time_utc: null
          }
        ])
        .select("*")
        .single();

      if (ins.error) throw ins.error;

      setToast("Added game");
      await onUpdated();
    } catch (e) {
      setToast(`Add game error: ${e.message}`);
    }
  }

  async function saveGame(r) {
    try {
      const up = await supabase
        .from("matchups")
        .update({
          game_order: Number(r.game_order) || 1,
          label: null,
          start_time_utc: null,
          team_a: r.team_a?.trim() || "Team A",
          team_b: r.team_b?.trim() || "Team B"
        })
        .eq("id", r.id);

      if (up.error) throw up.error;

      setToast("Saved game");
      await onUpdated();
    } catch (e) {
      setToast(`Save game error: ${e.message}`);
    }
  }

  async function deleteGame(id) {
    try {
      const del = await supabase.from("matchups").delete().eq("id", id);
      if (del.error) throw del.error;
      setToast("Deleted game");
      await onUpdated();
    } catch (e) {
      setToast(`Delete error: ${e.message}`);
    }
  }

  async function saveResult(r) {
    try {
      const winner = r.winner === "A" || r.winner === "B" ? r.winner : null;
      const scoreA = r.score_a === "" ? null : Number(r.score_a);
      const scoreB = r.score_b === "" ? null : Number(r.score_b);

      const up = await supabase
        .from("matchups")
        .update({
          winner,
          score_a: scoreA,
          score_b: scoreB
        })
        .eq("id", r.id);

      if (up.error) throw up.error;

      setToast("Saved result");
      await onUpdated();
    } catch (e) {
      setToast(`Result error: ${e.message}`);
    }
  }

  const picksForManageRound = useMemo(() => {
    const ids = new Set(matchupsInManageRound.map((m) => m.id));
    return allPicks.filter((p) => ids.has(p.matchup_id));
  }, [allPicks, matchupsInManageRound]);

  const entryById = useMemo(() => {
    const map = new Map();
    for (const e of entries) map.set(e.id, e);
    return map;
  }, [entries]);

  const matchupById = useMemo(() => {
    const map = new Map();
    for (const m of matchupsInManageRound) map.set(m.id, m);
    return map;
  }, [matchupsInManageRound]);

  const submittedPickRows = useMemo(() => {
    const byEntry = new Map();
    for (const p of picksForManageRound) {
      if (!byEntry.has(p.entry_id)) byEntry.set(p.entry_id, []);
      byEntry.get(p.entry_id).push(p);
    }

    const rowsOut = [];
    for (const [entryId, picks] of byEntry.entries()) {
      const e = entryById.get(entryId);
      const name = e ? `${e.first_name} ${e.last_name}` : "Unknown";

      picks.sort((a, b) => {
        const ma = matchupById.get(a.matchup_id);
        const mb = matchupById.get(b.matchup_id);
        return (ma?.game_order ?? 0) - (mb?.game_order ?? 0);
      });

      rowsOut.push({ entryId, name, picks });
    }

    rowsOut.sort((a, b) => a.name.localeCompare(b.name));
    return rowsOut;
  }, [picksForManageRound, entryById, matchupById]);

  if (!authed) {
    return (
      <Card>
        <h2 style={styles.h2}>Admin</h2>
        <p style={styles.p}>Enter the admin password.</p>

        <div style={{ maxWidth: 420 }}>
          <div style={styles.label}>Admin password</div>
          <input
            style={styles.input}
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") checkPw();
            }}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <button style={styles.primaryBtn} onClick={checkPw}>
            Unlock Admin
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={styles.sectionHead}>
          <div>
            <h2 style={{ ...styles.h2, marginBottom: 0 }}>Admin</h2>
            <div style={styles.p}>Manage the current round lock, games, results, and view submitted picks.</div>
          </div>
          <button style={styles.navBtn} onClick={lockAdmin}>
            Lock Admin
          </button>
        </div>
      </Card>

      <Card>
        <h2 style={styles.h2}>Round settings (current round)</h2>

        <div style={styles.formRow}>
          <div style={styles.field}>
            <div style={styles.label}>Current round name</div>
            <input style={styles.input} value={roundName} onChange={(e) => setRoundName(e.target.value)} />
          </div>
          <div style={styles.field}>
            <div style={styles.label}>Lock time (local)</div>
            <input style={styles.input} type="datetime-local" value={lockLocal} onChange={(e) => setLockLocal(e.target.value)} />
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <button style={styles.primaryBtn} onClick={saveRoundSettings}>
            Save settings
          </button>
        </div>
      </Card>

      <Card>
        <h2 style={styles.h2}>Manage a round</h2>

        <div style={{ marginTop: 10 }}>
          <div style={styles.label}>Round</div>
          <select style={styles.select} value={manageRound} onChange={(e) => setManageRound(e.target.value)}>
            {rounds.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button style={styles.navBtn} onClick={addGame}>
            + Add game
          </button>
        </div>

        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div key={r.id} style={styles.adminGameCard}>
              <div style={styles.adminGridSimple}>
                <div>
                  <div style={styles.label}>Order</div>
                  <input style={styles.inputSm} value={r.game_order} onChange={(e) => updateRow(r.id, { game_order: e.target.value })} />
                </div>
                <div>
                  <div style={styles.label}>Team A</div>
                  <input style={styles.inputSm} value={r.team_a} onChange={(e) => updateRow(r.id, { team_a: e.target.value })} />
                </div>
                <div>
                  <div style={styles.label}>Team B</div>
                  <input style={styles.inputSm} value={r.team_b} onChange={(e) => updateRow(r.id, { team_b: e.target.value })} />
                </div>
              </div>

              <div style={styles.adminActions}>
                <button style={styles.primaryBtnSm} onClick={() => saveGame(r)}>
                  Save
                </button>
                <button style={styles.dangerBtnSm} onClick={() => deleteGame(r.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}

          {!rows.length && <div style={styles.empty}>No games yet for this round.</div>}
        </div>
      </Card>

      <Card>
        <h2 style={styles.h2}>Enter results (selected round)</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div key={r.id} style={styles.adminResultCard}>
              <div style={{ fontWeight: 950 }}>
                {r.team_a} at {r.team_b}
              </div>

              <div style={styles.resultGridSimple}>
                <div style={{ flex: 2, minWidth: 220 }}>
                  <div style={styles.label}>Winner</div>
                  <select style={styles.inputSm} value={r.winner} onChange={(e) => updateRow(r.id, { winner: e.target.value })}>
                    <option value="">Not decided</option>
                    <option value="A">{r.team_a}</option>
                    <option value="B">{r.team_b}</option>
                  </select>
                </div>

                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={styles.label}>{r.team_a} score</div>
                  <input style={styles.inputSm} value={r.score_a} onChange={(e) => updateRow(r.id, { score_a: e.target.value })} inputMode="numeric" />
                </div>

                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={styles.label}>{r.team_b} score</div>
                  <input style={styles.inputSm} value={r.score_b} onChange={(e) => updateRow(r.id, { score_b: e.target.value })} inputMode="numeric" />
                </div>

                <div style={{ flex: 1, minWidth: 140, display: "flex", alignItems: "end" }}>
                  <button style={styles.primaryBtnSmWide} onClick={() => saveResult(r)}>
                    Save result
                  </button>
                </div>
              </div>
            </div>
          ))}

          {!rows.length && <div style={styles.empty}>No games to score yet for this round.</div>}
        </div>
      </Card>

      <Card>
        <h2 style={styles.h2}>Submitted picks (selected round)</h2>

        {!matchupsInManageRound.length ? (
          <div style={styles.empty}>No games in this round yet.</div>
        ) : submittedPickRows.length === 0 ? (
          <div style={styles.empty}>No picks submitted for this round yet.</div>
        ) : (
          <div style={styles.picksTableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Name</th>
                  {matchupsInManageRound
                    .slice()
                    .sort((a, b) => (a.game_order ?? 0) - (b.game_order ?? 0))
                    .map((m, idx) => (
                      <th key={m.id} style={styles.th}>
                        Game {idx + 1}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {submittedPickRows.map((row) => {
                  const pickMap = new Map(row.picks.map((p) => [p.matchup_id, p.picked]));
                  return (
                    <tr key={row.entryId}>
                      <td style={styles.tdStrong}>{row.name}</td>
                      {matchupsInManageRound
                        .slice()
                        .sort((a, b) => (a.game_order ?? 0) - (b.game_order ?? 0))
                        .map((m) => {
                          const side = pickMap.get(m.id);
                          const team = side ? (side === "A" ? m.team_a : m.team_b) : "—";
                          return (
                            <td key={m.id} style={styles.td}>
                              {team}
                            </td>
                          );
                        })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Small UI bits ---------------- */

function Card({ children }) {
  return <div style={styles.card}>{children}</div>;
}

function PickButton({ label, active, disabled, onClick }) {
  return (
    <button
      style={{
        ...styles.teamBtn,
        ...(active ? styles.teamBtnActive : null),
        ...(disabled ? styles.teamBtnDisabled : null)
      }}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function StatSide({ team, pct, count, names, winning }) {
  return (
    <div style={{ ...styles.statCol, ...(winning ? styles.statColWinner : null) }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontWeight: 950 }}>{team}</div>
        <div style={{ fontWeight: 900, color: "rgba(15,23,42,0.75)" }}>
          {pct}% ({count})
        </div>
      </div>

      <div style={styles.barBg}>
        <div style={{ ...styles.barFill, width: `${pct}%` }} />
      </div>

      <div style={styles.nameList}>{names.length ? names.join(", ") : "—"}</div>
    </div>
  );
}

function Leaderboard({ leaderboard }) {
  return (
    <div style={styles.board}>
      {leaderboard.map((r, idx) => (
        <div key={r.entry_id} style={styles.boardRow}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={styles.rankPill}>{idx + 1}</div>
            <div style={{ fontWeight: 900 }}>{r.name}</div>
          </div>
          <div style={{ fontWeight: 950, fontSize: 18 }}>{r.points}</div>
        </div>
      ))}
      {!leaderboard.length && <div style={styles.empty}>No entries yet.</div>}
    </div>
  );
}

function normalizeRows(matchups) {
  return (matchups || []).map((m) => ({
    id: m.id,
    game_order: m.game_order,
    team_a: m.team_a || "",
    team_b: m.team_b || "",
    winner: m.winner || "",
    score_a: m.score_a ?? "",
    score_b: m.score_b ?? ""
  }));
}

/* ---------------- Styles ---------------- */

const styles = {
  page: {
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f7f8fb 0%, #eef2ff 100%)",
    color: "#0f172a"
  },
  loading: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    background: "linear-gradient(180deg, #f7f8fb 0%, #eef2ff 100%)",
    color: "#0f172a",
    fontWeight: 800
  },
  toast: {
    position: "fixed",
    top: 14,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 999,
    background: "rgba(15, 23, 42, 0.92)",
    color: "white",
    padding: "10px 14px",
    borderRadius: 999,
    boxShadow: "0 10px 25px rgba(15,23,42,0.25)",
    fontWeight: 800,
    fontSize: 13,
    maxWidth: "92vw",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  },
  topbar: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    backdropFilter: "blur(10px)",
    background: "rgba(247, 248, 251, 0.75)",
    borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
    padding: 14,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap"
  },
  brand: { fontWeight: 950, fontSize: 16, letterSpacing: -0.2 },
  subhead: { marginTop: 4, fontSize: 12, color: "rgba(15,23,42,0.70)" },
  nav: { display: "flex", gap: 8, flexWrap: "wrap" },
  navBtn: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,0.12)",
    background: "rgba(255,255,255,0.9)",
    fontWeight: 900,
    cursor: "pointer"
  },
  navBtnDisabled: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,0.08)",
    background: "rgba(255,255,255,0.55)",
    fontWeight: 900,
    color: "rgba(15,23,42,0.35)"
  },
  container: { maxWidth: 1050, margin: "0 auto", padding: "18px 14px 40px" },
  card: {
    border: "1px solid rgba(15, 23, 42, 0.10)",
    borderRadius: 18,
    padding: 18,
    background: "rgba(255, 255, 255, 0.92)",
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)"
  },
  homeBottomRow: { marginTop: 18, display: "flex", justifyContent: "flex-end" },
  adminSmallBtn: {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(15,23,42,0.12)",
    background: "rgba(255,255,255,0.9)",
    fontWeight: 900,
    cursor: "pointer",
    fontSize: 12,
    color: "rgba(15,23,42,0.75)"
  },
  h2: { margin: "0 0 8px 0", fontSize: 22, fontWeight: 950, letterSpacing: -0.25 },
  p: { margin: "8px 0 12px 0", color: "rgba(15, 23, 42, 0.75)", lineHeight: 1.45 },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 950,
    marginTop: 10,
    marginBottom: 6,
    color: "rgba(15, 23, 42, 0.65)",
    textTransform: "uppercase",
    letterSpacing: 0.7
  },

  // FIX: prevent overlap and overflow in the home page fields
  formRow: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "stretch",
    maxWidth: "100%",
    boxSizing: "border-box"
  },
  field: {
    flex: "1 1 260px",
    minWidth: 240,
    maxWidth: "100%",
    boxSizing: "border-box"
  },

  input: {
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.14)",
    outline: "none",
    fontSize: 16,
    background: "white"
  },
  inputSm: {
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    padding: "10px 10px",
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.14)",
    outline: "none",
    fontSize: 14,
    background: "white",
    fontWeight: 800
  },
  select: {
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.14)",
    outline: "none",
    fontSize: 15,
    background: "white",
    fontWeight: 800
  },
  primaryBtn: {
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.95)",
    background: "rgba(15, 23, 42, 0.95)",
    color: "#fff",
    fontWeight: 950,
    cursor: "pointer",
    boxShadow: "0 10px 18px rgba(15, 23, 42, 0.16)"
  },
  primaryBtnSm: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.95)",
    background: "rgba(15, 23, 42, 0.95)",
    color: "#fff",
    fontWeight: 950,
    cursor: "pointer"
  },
  primaryBtnSmWide: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.95)",
    background: "rgba(15, 23, 42, 0.95)",
    color: "#fff",
    fontWeight: 950,
    cursor: "pointer"
  },
  dangerBtnSm: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.12)",
    background: "rgba(255,255,255,0.9)",
    color: "#b91c1c",
    fontWeight: 950,
    cursor: "pointer"
  },
  sectionHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" },
  sectionKicker: { fontSize: 12, fontWeight: 950, color: "rgba(15,23,42,0.60)", textTransform: "uppercase", letterSpacing: 0.7 },
  sectionTitle: { fontSize: 22, fontWeight: 950, letterSpacing: -0.25, marginTop: 2 },
  badgeOpen: {
    padding: "8px 10px",
    borderRadius: 999,
    background: "rgba(22, 101, 52, 0.10)",
    border: "1px solid rgba(22, 101, 52, 0.25)",
    color: "#166534",
    fontWeight: 950,
    fontSize: 12
  },
  badgeLocked: {
    padding: "8px 10px",
    borderRadius: 999,
    background: "rgba(185, 28, 28, 0.08)",
    border: "1px solid rgba(185, 28, 28, 0.25)",
    color: "#b91c1c",
    fontWeight: 950,
    fontSize: 12
  },
  list: { display: "flex", flexDirection: "column", gap: 12, marginTop: 12 },
  empty: {
    marginTop: 12,
    padding: 14,
    borderRadius: 16,
    border: "1px dashed rgba(15,23,42,0.18)",
    background: "rgba(255,255,255,0.6)",
    color: "rgba(15,23,42,0.7)",
    fontWeight: 800
  },
  gameCard: {
    border: "1px solid rgba(15, 23, 42, 0.10)",
    borderRadius: 18,
    padding: 14,
    background: "rgba(255, 255, 255, 0.95)",
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.06)"
  },
  gameTop: { display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" },
  gameTitle: { fontWeight: 950, fontSize: 16 },
  pickRow: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 },
  teamBtn: {
    flex: 1,
    minWidth: 220,
    padding: "14px 14px",
    borderRadius: 18,
    border: "1px solid rgba(15, 23, 42, 0.12)",
    background: "white",
    cursor: "pointer",
    fontWeight: 950,
    textAlign: "left",
    fontSize: 16,
    boxShadow: "0 6px 16px rgba(15, 23, 42, 0.06)"
  },
  teamBtnActive: {
    background: "rgba(15,23,42,0.95)",
    color: "white",
    border: "1px solid rgba(15,23,42,0.95)",
    boxShadow: "0 10px 20px rgba(15,23,42,0.18)"
  },
  teamBtnDisabled: { opacity: 0.65, cursor: "not-allowed" },
  tabs: {
    marginTop: 10,
    display: "inline-flex",
    gap: 6,
    padding: 6,
    borderRadius: 16,
    border: "1px solid rgba(15,23,42,0.10)",
    background: "rgba(255,255,255,0.75)"
  },
  tab: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid transparent",
    background: "transparent",
    fontWeight: 950,
    cursor: "pointer",
    color: "rgba(15,23,42,0.75)"
  },
  tabActive: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(15,23,42,0.95)",
    background: "rgba(15,23,42,0.95)",
    fontWeight: 950,
    cursor: "pointer",
    color: "white"
  },
  statsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 },
  statCol: {
    flex: 1,
    minWidth: 260,
    border: "1px solid rgba(15, 23, 42, 0.10)",
    borderRadius: 18,
    padding: 12,
    background: "rgba(238, 242, 255, 0.55)"
  },
  statColWinner: {
    background: "rgba(22, 163, 74, 0.14)",
    border: "1px solid rgba(22, 163, 74, 0.35)"
  },
  barBg: { marginTop: 10, height: 10, borderRadius: 999, background: "rgba(15,23,42,0.10)", overflow: "hidden" },
  barFill: { height: 10, borderRadius: 999, background: "rgba(15,23,42,0.95)" },
  nameList: { marginTop: 10, fontSize: 12, color: "rgba(15, 23, 42, 0.78)", lineHeight: 1.5 },
  board: { border: "1px solid rgba(15,23,42,0.10)", borderRadius: 18, overflow: "hidden", background: "rgba(255,255,255,0.95)" },
  boardRow: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottom: "1px solid rgba(15,23,42,0.06)" },
  rankPill: { width: 34, height: 34, borderRadius: 14, background: "rgba(15,23,42,0.95)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 950 },
  winnerPill: { padding: "8px 10px", borderRadius: 999, background: "rgba(22, 163, 74, 0.12)", border: "1px solid rgba(22, 163, 74, 0.30)", color: "#14532d", fontWeight: 900, fontSize: 12 },
  noWinnerPill: { padding: "8px 10px", borderRadius: 999, background: "rgba(15,23,42,0.06)", border: "1px solid rgba(15,23,42,0.10)", color: "rgba(15,23,42,0.75)", fontWeight: 900, fontSize: 12 },
  correctLine: { marginTop: 10, padding: "10px 12px", borderRadius: 14, background: "rgba(22, 163, 74, 0.12)", border: "1px solid rgba(22, 163, 74, 0.30)", color: "#14532d", fontWeight: 950 },
  incorrectLine: { marginTop: 10, padding: "10px 12px", borderRadius: 14, background: "rgba(185, 28, 28, 0.08)", border: "1px solid rgba(185, 28, 28, 0.25)", color: "#7f1d1d", fontWeight: 950 },

  adminGameCard: { border: "1px solid rgba(15,23,42,0.10)", borderRadius: 18, padding: 14, background: "rgba(255,255,255,0.9)" },
  adminGridSimple: { display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 10 },
  adminActions: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 },
  adminResultCard: { border: "1px solid rgba(15,23,42,0.10)", borderRadius: 18, padding: 14, background: "rgba(255,255,255,0.95)" },
  resultGridSimple: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 },

  picksTableWrap: {
    width: "100%",
    overflowX: "auto",
    marginTop: 10,
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,0.10)",
    background: "rgba(255,255,255,0.95)"
  },
  table: { borderCollapse: "collapse", width: "100%" },
  th: { textAlign: "left", padding: 12, borderBottom: "1px solid rgba(15,23,42,0.08)", fontSize: 12, color: "rgba(15,23,42,0.65)", whiteSpace: "nowrap" },
  td: { padding: 12, borderBottom: "1px solid rgba(15,23,42,0.06)", whiteSpace: "nowrap" },
  tdStrong: { padding: 12, borderBottom: "1px solid rgba(15,23,42,0.06)", fontWeight: 950, whiteSpace: "nowrap" }
};

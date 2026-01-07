import React, { useEffect, useMemo, useState } from "react";
import { supabase, normalizeName, fmtLocal } from "./supabase";
import { isLocked, computeLeaderboard, computeMatchupStats } from "./logic";

const ADMIN_KEY = "je_picks_admin_authed";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const [contest, setContest] = useState(null);
  const [matchups, setMatchups] = useState([]);
  const [entries, setEntries] = useState([]);
  const [allPicks, setAllPicks] = useState([]);

  const [view, setView] = useState("home"); // home | picks | results | admin
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [me, setMe] = useState(null);

  const [myPicks, setMyPicks] = useState({}); // matchup_id -> 'A' | 'B'

  const locked = useMemo(() => isLocked(contest?.round_lock_utc), [contest?.round_lock_utc]);
  const roundName = contest?.current_round_name || "Current Round";
  const lockText = contest?.round_lock_utc ? fmtLocal(contest.round_lock_utc) : "Not set";

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  async function loadAll() {
    setLoading(true);

    const c = await supabase
      .from("contests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (c.error) {
      setToast(`Contest load error: ${c.error.message}`);
      setLoading(false);
      return;
    }
    setContest(c.data);

    const round = c.data?.current_round_name;

    const m = await supabase
      .from("matchups")
      .select("*")
      .eq("contest_id", c.data.id)
      .eq("round_name", round)
      .order("game_order", { ascending: true });

    if (m.error) setToast(`Matchups load error: ${m.error.message}`);
    setMatchups(m.data || []);

    const e = await supabase
      .from("entries")
      .select("*")
      .eq("contest_id", c.data.id)
      .order("created_at", { ascending: true });

    if (e.error) setToast(`Entries load error: ${e.error.message}`);
    setEntries(e.data || []);

    const p = await supabase.from("picks").select("*").eq("contest_id", c.data.id);
    if (p.error) setToast(`Picks load error: ${p.error.message}`);
    setAllPicks(p.data || []);

    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 25000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leaderboard = useMemo(() => {
    return computeLeaderboard(entries, matchups, allPicks);
  }, [entries, matchups, allPicks]);

  async function continueWithName() {
    const fn = first.trim();
    const ln = last.trim();
    if (!fn || !ln) {
      setToast("Enter first and last name.");
      return;
    }
    if (!contest) {
      setToast("Contest not loaded yet. Try refresh.");
      return;
    }

    const nk = normalizeName(fn, ln);

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
      if (locked) {
        setToast("Round is locked and no entry exists for that name.");
        return;
      }
      const ins = await supabase
        .from("entries")
        .insert([
          {
            contest_id: contest.id,
            first_name: fn,
            last_name: ln,
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
      await loadAll();
    }

    setMe(entry);

    // load my picks
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

    setView(locked ? "results" : "picks");
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

    // instant UI
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
    await loadAll();
  }

  function goHome() {
    setView("home");
  }

  if (loading) {
    return <div style={styles.loading}>Loading…</div>;
  }

  return (
    <div style={styles.page}>
      {/* Toast */}
      {toast && <div style={styles.toast}>{toast}</div>}

      {/* Header */}
      <div style={styles.topbar}>
        <div>
          <div style={styles.brand}>JE NFL Picks</div>
          <div style={styles.subhead}>
            <b>{roundName}</b> • Locks: <b>{lockText}</b> •{" "}
            <span style={{ color: locked ? "#b91c1c" : "#166534", fontWeight: 900 }}>
              {locked ? "LOCKED" : "OPEN"}
            </span>
          </div>
        </div>

        <div style={styles.nav}>
          <button style={styles.navBtn} onClick={goHome}>
            Home
          </button>

          <button
            style={me ? styles.navBtn : styles.navBtnDisabled}
            onClick={() => setView(locked ? "results" : "picks")}
            disabled={!me}
          >
            {locked ? "Results" : "My Picks"}
          </button>

          <button style={styles.navBtn} onClick={() => setView("admin")}>
            Admin
          </button>

          <button style={styles.navBtn} onClick={loadAll}>
            Refresh
          </button>
        </div>
      </div>

      {/* Main */}
      <div style={styles.container}>
        {view === "home" && (
          <Card>
            <h2 style={styles.h2}>{locked ? "View results" : "Make your picks"}</h2>
            <p style={styles.p}>
              {locked
                ? "Enter your name to view your picks, score, public stats, and leaderboard."
                : "Enter your name and tap winners. It auto-saves. You can change picks until lock time."}
            </p>

            <div style={styles.formRow}>
              <div style={{ flex: 1 }}>
                <div style={styles.label}>First name</div>
                <input style={styles.input} value={first} onChange={(e) => setFirst(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={styles.label}>Last name</div>
                <input style={styles.input} value={last} onChange={(e) => setLast(e.target.value)} />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <button style={styles.primaryBtn} onClick={continueWithName}>
                {locked ? "View" : "Continue"}
              </button>
            </div>

            <div style={styles.tip}>
              Admin tip: Use the Admin page to add games + set lock time + enter winners/scores.
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
                      Tap the winner for each game. Picks auto-save.
                    </div>
                  </div>
                  <div style={styles.badgeOpen}>OPEN</div>
                </div>

                {matchups.length === 0 ? (
                  <div style={styles.empty}>
                    No games entered yet. (Admin needs to add matchups.)
                  </div>
                ) : (
                  <div style={styles.list}>
                    {matchups.map((m) => {
                      const picked = myPicks[m.id] || null;
                      return (
                        <div key={m.id} style={styles.gameCard}>
                          <div style={styles.gameTop}>
                            <div>
                              <div style={styles.gameLabel}>{m.label || `Game ${m.game_order}`}</div>
                              {m.start_time_utc && (
                                <div style={styles.gameMeta}>
                                  Starts: {new Date(m.start_time_utc).toLocaleString()}
                                </div>
                              )}
                            </div>
                          </div>

                          <div style={styles.pickRow}>
                            <PickButton
                              label={m.team_a}
                              active={picked === "A"}
                              onClick={() => setPick(m.id, "A")}
                              disabled={false}
                            />
                            <PickButton
                              label={m.team_b}
                              active={picked === "B"}
                              onClick={() => setPick(m.id, "B")}
                              disabled={false}
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
            matchups={matchups}
            entries={entries}
            allPicks={allPicks}
            leaderboard={leaderboard}
          />
        )}

        {view === "admin" && (
          <AdminPanel contest={contest} matchups={matchups} onUpdated={loadAll} setToast={setToast} />
        )}
      </div>
    </div>
  );
}

/* ---------------- UI Pieces ---------------- */

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

function ResultsHub({ me, matchups, entries, allPicks, leaderboard }) {
  const [tab, setTab] = useState("me"); // me | stats | board

  if (!me) {
    return (
      <Card>
        <h2 style={styles.h2}>Enter your name first</h2>
        <p style={styles.p}>Go to Home and log in with your name.</p>
      </Card>
    );
  }

  // compute my score this round so far (1 per correct pick)
  const my = allPicks.filter((p) => p.entry_id === me.id);
  const byMatchup = new Map(matchups.map((m) => [m.id, m]));

  let points = 0;
  for (const p of my) {
    const m = byMatchup.get(p.matchup_id);
    if (!m?.winner) continue;
    if (p.picked === m.winner) points += 1;
  }

  return (
    <Card>
      <div style={styles.sectionHead}>
        <div>
          <div style={styles.sectionKicker}>Round locked</div>
          <div style={styles.sectionTitle}>
            {me.first_name} {me.last_name}
          </div>
          <div style={styles.p}>
            Your points so far: <b>{points}</b>
          </div>
        </div>
        <div style={styles.badgeLocked}>LOCKED</div>
      </div>

      <div style={styles.tabs}>
        <button style={tab === "me" ? styles.tabActive : styles.tab} onClick={() => setTab("me")}>
          My picks
        </button>
        <button style={tab === "stats" ? styles.tabActive : styles.tab} onClick={() => setTab("stats")}>
          Round stats
        </button>
        <button style={tab === "board" ? styles.tabActive : styles.tab} onClick={() => setTab("board")}>
          Leaderboard
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        {tab === "me" && <MyPicksLocked matchups={matchups} my={my} />}
        {tab === "stats" && <RoundStats matchups={matchups} entries={entries} allPicks={allPicks} />}
        {tab === "board" && <Leaderboard leaderboard={leaderboard} />}
      </div>
    </Card>
  );
}

function MyPicksLocked({ matchups, my }) {
  const pickByMatchup = new Map(my.map((p) => [p.matchup_id, p.picked]));

  return (
    <div style={styles.list}>
      {matchups.map((m) => {
        const pickedSide = pickByMatchup.get(m.id);
        const pickedTeam = pickedSide ? (pickedSide === "A" ? m.team_a : m.team_b) : "(no pick)";
        const correct = m.winner ? pickedSide === m.winner : null;

        return (
          <div key={m.id} style={styles.gameCard}>
            <div style={styles.gameTop}>
              <div>
                <div style={styles.gameLabel}>{m.label || `Game ${m.game_order}`}</div>
                <div style={styles.gameMeta}>
                  Your pick: <b>{pickedTeam}</b>
                </div>
              </div>
              {m.winner && (
                <div style={{ textAlign: "right" }}>
                  <div style={styles.gameMeta}>
                    Winner: <b>{m.winner === "A" ? m.team_a : m.team_b}</b>
                  </div>
                  <div style={styles.gameMeta}>
                    Final: {m.score_a ?? ""}-{m.score_b ?? ""}
                  </div>
                </div>
              )}
            </div>

            {m.winner && (
              <div style={{ marginTop: 10, fontWeight: 900, color: correct ? "#166534" : "#b91c1c" }}>
                {correct ? "Correct (+1)" : "Wrong (+0)"}
              </div>
            )}
          </div>
        );
      })}

      {!matchups.length && <div style={styles.empty}>No games found.</div>}
    </div>
  );
}

function RoundStats({ matchups, entries, allPicks }) {
  return (
    <div style={styles.list}>
      {matchups.map((m) => {
        const picksForMatchup = allPicks.filter((p) => p.matchup_id === m.id);
        const s = computeMatchupStats(m, entries, picksForMatchup);

        return (
          <div key={m.id} style={styles.gameCard}>
            <div style={styles.gameTop}>
              <div>
                <div style={styles.gameLabel}>{m.label || `Game ${m.game_order}`}</div>
                <div style={styles.gameMeta}>
                  Total picks: <b>{s.total}</b>
                </div>
              </div>
              {m.winner && (
                <div style={{ textAlign: "right" }}>
                  <div style={styles.gameMeta}>
                    Winner: <b>{m.winner === "A" ? m.team_a : m.team_b}</b>
                  </div>
                  <div style={styles.gameMeta}>
                    Final: {m.score_a ?? ""}-{m.score_b ?? ""}
                  </div>
                </div>
              )}
            </div>

            <div style={styles.statsRow}>
              <StatSide team={m.team_a} pct={s.aPct} count={s.aCount} names={s.aPickers} />
              <StatSide team={m.team_b} pct={s.bPct} count={s.bCount} names={s.bPickers} />
            </div>
          </div>
        );
      })}

      {!matchups.length && <div style={styles.empty}>No games found.</div>}
    </div>
  );
}

function StatSide({ team, pct, count, names }) {
  return (
    <div style={styles.statCol}>
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

/* ---------------- Admin Panel (no JSON) ---------------- */

function AdminPanel({ contest, matchups, onUpdated, setToast }) {
  const [authed, setAuthed] = useState(localStorage.getItem(ADMIN_KEY) === "1");
  const [pw, setPw] = useState("");

  // round settings
  const [roundName, setRoundName] = useState(contest?.current_round_name || "");
  const [lockLocal, setLockLocal] = useState(contest?.round_lock_utc ? contest.round_lock_utc.slice(0, 16) : "");

  // editable matchup rows
  const [rows, setRows] = useState(() => normalizeRows(matchups));

  useEffect(() => {
    setRows(normalizeRows(matchups));
  }, [matchups]);

  function checkPw() {
    const expected = import.meta.env.VITE_ADMIN_PASSWORD || "";
    if (!expected) {
      setToast("Set VITE_ADMIN_PASSWORD in Netlify env vars.");
      return;
    }
    if (pw === expected) {
      localStorage.setItem(ADMIN_KEY, "1");
      setAuthed(true);
      setToast("Admin unlocked");
    } else {
      setToast("Wrong admin password");
    }
  }

  function updateRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveRoundSettings() {
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
    try {
      const nextOrder = (rows.reduce((mx, r) => Math.max(mx, Number(r.game_order) || 0), 0) || 0) + 1;

      const ins = await supabase
        .from("matchups")
        .insert([
          {
            contest_id: contest.id,
            round_name: contest.current_round_name,
            game_order: nextOrder,
            label: `Game ${nextOrder}`,
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
          label: r.label?.trim() ? r.label.trim() : null,
          team_a: r.team_a?.trim() || "Team A",
          team_b: r.team_b?.trim() || "Team B",
          start_time_utc: r.start_time_utc ? new Date(r.start_time_utc).toISOString() : null
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

  if (!authed) {
    return (
      <Card>
        <h2 style={styles.h2}>Admin</h2>
        <p style={styles.p}>Enter the admin password you set in Netlify.</p>

        <div style={{ maxWidth: 420 }}>
          <div style={styles.label}>Admin password</div>
          <input style={styles.input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
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
        <h2 style={styles.h2}>Round settings</h2>
        <p style={styles.p}>Set the round name and the lock time (when picks close).</p>

        <div style={styles.formRow}>
          <div style={{ flex: 1 }}>
            <div style={styles.label}>Current round name</div>
            <input style={styles.input} value={roundName} onChange={(e) => setRoundName(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
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
        <div style={styles.adminHead}>
          <div>
            <h2 style={styles.h2}>Games</h2>
            <div style={styles.p}>Add/edit matchups for the current round.</div>
          </div>
          <button style={styles.navBtn} onClick={addGame}>
            + Add game
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div key={r.id} style={styles.adminGameCard}>
              <div style={styles.adminGrid}>
                <div>
                  <div style={styles.label}>Order</div>
                  <input style={styles.inputSm} value={r.game_order} onChange={(e) => updateRow(r.id, { game_order: e.target.value })} />
                </div>

                <div style={{ gridColumn: "span 2" }}>
                  <div style={styles.label}>Label</div>
                  <input style={styles.inputSm} value={r.label} onChange={(e) => updateRow(r.id, { label: e.target.value })} />
                </div>

                <div>
                  <div style={styles.label}>Team A</div>
                  <input style={styles.inputSm} value={r.team_a} onChange={(e) => updateRow(r.id, { team_a: e.target.value })} />
                </div>

                <div>
                  <div style={styles.label}>Team B</div>
                  <input style={styles.inputSm} value={r.team_b} onChange={(e) => updateRow(r.id, { team_b: e.target.value })} />
                </div>

                <div>
                  <div style={styles.label}>Start time (local)</div>
                  <input
                    style={styles.inputSm}
                    type="datetime-local"
                    value={r.start_time_utc}
                    onChange={(e) => updateRow(r.id, { start_time_utc: e.target.value })}
                  />
                </div>
              </div>

              <div style={styles.adminActions}>
                <button style={styles.primaryBtnSm} onClick={() => saveGame(r)}>
                  Save game
                </button>
                <button style={styles.dangerBtnSm} onClick={() => deleteGame(r.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}

          {!rows.length && <div style={styles.empty}>No games yet. Click “Add game.”</div>}
        </div>
      </Card>

      <Card>
        <h2 style={styles.h2}>Results</h2>
        <p style={styles.p}>After a game ends, set winner and score. Leaderboard updates automatically.</p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div key={r.id} style={styles.adminResultCard}>
              <div style={{ fontWeight: 950 }}>{r.label || `Game ${r.game_order}`}</div>
              <div style={{ color: "rgba(15,23,42,0.7)", marginTop: 4 }}>
                {r.team_a} vs {r.team_b}
              </div>

              <div style={styles.resultGrid}>
                <div style={{ gridColumn: "span 2" }}>
                  <div style={styles.label}>Winner</div>
                  <select style={styles.inputSm} value={r.winner} onChange={(e) => updateRow(r.id, { winner: e.target.value })}>
                    <option value="">Not decided</option>
                    <option value="A">{r.team_a}</option>
                    <option value="B">{r.team_b}</option>
                  </select>
                </div>

                <div>
                  <div style={styles.label}>{r.team_a} score</div>
                  <input style={styles.inputSm} value={r.score_a} onChange={(e) => updateRow(r.id, { score_a: e.target.value })} inputMode="numeric" />
                </div>

                <div>
                  <div style={styles.label}>{r.team_b} score</div>
                  <input style={styles.inputSm} value={r.score_b} onChange={(e) => updateRow(r.id, { score_b: e.target.value })} inputMode="numeric" />
                </div>

                <div style={{ display: "flex", alignItems: "end" }}>
                  <button style={styles.primaryBtnSmWide} onClick={() => saveResult(r)}>
                    Save result
                  </button>
                </div>
              </div>
            </div>
          ))}

          {!rows.length && <div style={styles.empty}>No games to score yet.</div>}
        </div>
      </Card>
    </div>
  );
}

function normalizeRows(matchups) {
  return (matchups || []).map((m) => ({
    id: m.id,
    game_order: m.game_order,
    label: m.label || "",
    team_a: m.team_a || "",
    team_b: m.team_b || "",
    start_time_utc: m.start_time_utc ? m.start_time_utc.slice(0, 16) : "",
    winner: m.winner || "",
    score_a: m.score_a ?? "",
    score_b: m.score_b ?? ""
  }));
}

/* ---------------- Styles (modern, no Tailwind) ---------------- */

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
    fontSize: 13
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

  container: {
    maxWidth: 1050,
    margin: "0 auto",
    padding: "18px 14px 40px"
  },

  card: {
    border: "1px solid rgba(15, 23, 42, 0.10)",
    borderRadius: 18,
    padding: 18,
    background: "rgba(255, 255, 255, 0.92)",
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)"
  },

  h2: { margin: "0 0 8px 0", fontSize: 22, fontWeight: 950, letterSpacing: -0.25 },

  p: { margin: "8px 0 12px 0", color: "rgba(15, 23, 42, 0.75)", lineHeight: 1.45 },

  tip: { marginTop: 12, fontSize: 12, color: "rgba(15,23,42,0.60)", fontWeight: 700 },

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

  formRow: { display: "flex", gap: 12, flexWrap: "wrap" },

  input: {
    width: "100%",
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.14)",
    outline: "none",
    fontSize: 16,
    background: "white"
  },

  inputSm: {
    width: "100%",
    padding: "10px 10px",
    borderRadius: 14,
    border: "1px solid rgba(15, 23, 42, 0.14)",
    outline: "none",
    fontSize: 14,
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

  gameTop: { display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },

  gameLabel: { fontWeight: 950, fontSize: 16 },

  gameMeta: { marginTop: 4, fontSize: 12, color: "rgba(15,23,42,0.65)", fontWeight: 700 },

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

  barBg: { marginTop: 10, height: 10, borderRadius: 999, background: "rgba(15,23,42,0.10)", overflow: "hidden" },

  barFill: { height: 10, borderRadius: 999, background: "rgba(15,23,42,0.95)" },

  nameList: { marginTop: 10, fontSize: 12, color: "rgba(15, 23, 42, 0.78)", lineHeight: 1.5 },

  board: {
    border: "1px solid rgba(15,23,42,0.10)",
    borderRadius: 18,
    overflow: "hidden",
    background: "rgba(255,255,255,0.95)"
  },

  boardRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    borderBottom: "1px solid rgba(15,23,42,0.06)"
  },

  rankPill: {
    width: 34,
    height: 34,
    borderRadius: 14,
    background: "rgba(15,23,42,0.95)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 950
  },

  adminHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" },

  adminGameCard: {
    border: "1px solid rgba(15,23,42,0.10)",
    borderRadius: 18,
    padding: 14,
    background: "rgba(255,255,255,0.9)"
  },

  adminGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    gap: 10
  },

  adminActions: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 },

  adminResultCard: {
    border: "1px solid rgba(15,23,42,0.10)",
    borderRadius: 18,
    padding: 14,
    background: "rgba(255,255,255,0.95)"
  },

  resultGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    gap: 10,
    marginTop: 10
  }
};


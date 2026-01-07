import React, { useEffect, useMemo, useState } from "react";
import { supabase, normalizeName, fmtLocal } from "./supabase";
import { isLocked, computeLeaderboard, computeMatchupStats } from "./logic";

const ADMIN_KEY = "je_picks_admin_authed";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [contest, setContest] = useState(null);
  const [matchups, setMatchups] = useState([]);
  const [entries, setEntries] = useState([]);
  const [allPicks, setAllPicks] = useState([]);

  const [mode, setMode] = useState("home"); // home | picks | my | stats | leaderboard | admin
  const [msg, setMsg] = useState("");

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [me, setMe] = useState(null);

  const [myPicks, setMyPicks] = useState({}); // matchup_id -> 'A'|'B'

  const locked = useMemo(() => isLocked(contest?.round_lock_utc), [contest?.round_lock_utc]);

  async function loadAll() {
    setLoading(true);
    setMsg("");

    const c = await supabase.from("contests").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (c.error) {
      setMsg(`Error loading contest: ${c.error.message}`);
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

    if (m.error) {
      setMsg(`Error loading matchups: ${m.error.message}`);
    }
    setMatchups(m.data || []);

    const e = await supabase
      .from("entries")
      .select("*")
      .eq("contest_id", c.data.id)
      .order("created_at", { ascending: true });

    if (e.error) setMsg(`Error loading entries: ${e.error.message}`);
    setEntries(e.data || []);

    // pulls all picks for current round (used for stats + leaderboard after lock)
    const p = await supabase
      .from("picks")
      .select("*")
      .eq("contest_id", c.data.id);

    if (p.error) setMsg(`Error loading picks: ${p.error.message}`);
    setAllPicks(p.data || []);

    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // Optional: auto-refresh every 20s so results/lock changes show up without anyone reloading.
    const t = setInterval(loadAll, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upsertEntryAndLoadPicks() {
    setMsg("");
    const fn = first.trim();
    const ln = last.trim();
    if (!fn || !ln) {
      setMsg("Enter first and last name.");
      return;
    }
    if (!contest) {
      setMsg("Contest not loaded.");
      return;
    }

    const nk = normalizeName(fn, ln);

    // Find existing entry
    const existing = await supabase
      .from("entries")
      .select("*")
      .eq("contest_id", contest.id)
      .eq("name_key", nk)
      .limit(1)
      .maybeSingle();

    if (existing.error) {
      setMsg(`Lookup error: ${existing.error.message}`);
      return;
    }

    let entry = existing.data;

    // Create if not exists (only allowed before lock)
    if (!entry) {
      if (locked) {
        setMsg("Picks are locked and no bracket exists for that name.");
        return;
      }
      const ins = await supabase.from("entries").insert([{
        contest_id: contest.id,
        first_name: fn,
        last_name: ln,
        name_key: nk
      }]).select("*").single();

      if (ins.error) {
        setMsg(`Create error: ${ins.error.message}`);
        return;
      }
      entry = ins.data;
      await loadAll();
    }

    setMe(entry);

    // Load my picks for current round matchups
    const mp = await supabase
      .from("picks")
      .select("*")
      .eq("contest_id", contest.id)
      .eq("entry_id", entry.id);

    if (mp.error) {
      setMsg(`Error loading your picks: ${mp.error.message}`);
      return;
    }

    const map = {};
    for (const p of (mp.data || [])) {
      map[p.matchup_id] = p.picked;
    }
    setMyPicks(map);

    // After lock, default them to "my view"
    setMode(locked ? "my" : "picks");
  }

  async function savePick(matchupId, picked) {
    if (!me || !contest) {
      setMsg("Enter your name first.");
      return;
    }
    if (locked) {
      setMsg("This round is locked. You can’t change picks.");
      return;
    }

    setMyPicks(prev => ({ ...prev, [matchupId]: picked }));

    const up = await supabase.from("picks").upsert([{
      contest_id: contest.id,
      matchup_id: matchupId,
      entry_id: me.id,
      picked
    }], { onConflict: "entry_id,matchup_id" });

    if (up.error) {
      setMsg(`Save error: ${up.error.message}`);
      return;
    }

    await loadAll();
    setMsg("Saved.");
  }

  const leaderboard = useMemo(() => {
    return computeLeaderboard(entries, matchups, allPicks);
  }, [entries, matchups, allPicks]);

  function header() {
    return (
      <div style={styles.header}>
        <div style={{ fontWeight: 900 }}>JE NFL Picks</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={styles.smallBtn} onClick={() => setMode("home")}>Home</button>
          <button style={styles.smallBtn} onClick={() => setMode(locked ? "my" : "picks")} disabled={!me}>
            {locked ? "My Score" : "My Picks"}
          </button>
          <button style={styles.smallBtn} onClick={() => setMode("leaderboard")} disabled={!locked}>
            Leaderboard
          </button>
          <button style={styles.smallBtn} onClick={() => setMode("stats")} disabled={!locked}>
            Round Stats
          </button>
          <button style={styles.smallBtn} onClick={() => setMode("admin")}>
            Admin
          </button>
        </div>
      </div>
    );
  }

  if (loading) return <div style={styles.page}>Loading…</div>;

  const roundName = contest?.current_round_name || "Current Round";
  const lockText = contest?.round_lock_utc ? fmtLocal(contest.round_lock_utc) : "(not set)";

  return (
    <div style={styles.page}>
      {header()}
      {msg && <div style={styles.message}>{msg}</div>}

      <div style={{ ...styles.card, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 18 }}>{roundName}</div>
            <div style={{ opacity: 0.8 }}>Locks at: <b>{lockText}</b> • Status: <b>{locked ? "Locked" : "Open"}</b></div>
          </div>
          <button style={styles.smallBtn} onClick={loadAll}>Refresh</button>
        </div>
      </div>

      {mode === "home" && (
        <Home
          locked={locked}
          first={first}
          last={last}
          setFirst={setFirst}
          setLast={setLast}
          onContinue={upsertEntryAndLoadPicks}
        />
      )}

      {mode === "picks" && (
        <PicksPage
          locked={locked}
          me={me}
          matchups={matchups}
          myPicks={myPicks}
          onPick={savePick}
        />
      )}

      {mode === "my" && (
        <MyScorePage
          locked={locked}
          me={me}
          matchups={matchups}
          entries={entries}
          allPicks={allPicks}
          myPicks={myPicks}
        />
      )}

      {mode === "stats" && (
        <StatsPage
          matchups={matchups}
          entries={entries}
          allPicks={allPicks}
        />
      )}

      {mode === "leaderboard" && (
        <LeaderboardPage leaderboard={leaderboard} />
      )}

      {mode === "admin" && (
        <AdminPage contest={contest} matchups={matchups} onUpdated={loadAll} />
      )}
    </div>
  );
}

function Home({ locked, first, last, setFirst, setLast, onContinue }) {
  return (
    <div style={styles.card}>
      <h2 style={styles.h2}>{locked ? "Login to View" : "Make Your Picks"}</h2>
      <p style={styles.p}>
        {locked
          ? "Enter your name to view your picks, score, and this round’s stats."
          : "Enter your name to create or edit your picks for this round."}
      </p>

      <div style={styles.row}>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>First Name</label>
          <input style={styles.input} value={first} onChange={e => setFirst(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Last Name</label>
          <input style={styles.input} value={last} onChange={e => setLast(e.target.value)} />
        </div>
      </div>

      <button style={{ ...styles.primaryBtn, marginTop: 12 }} onClick={onContinue}>
        {locked ? "Login" : "Continue"}
      </button>

      {!locked && (
        <div style={{ marginTop: 10, opacity: 0.75 }}>
          You can change picks anytime before lock.
        </div>
      )}
    </div>
  );
}

function PicksPage({ locked, me, matchups, myPicks, onPick }) {
  if (!me) return <div style={styles.card}>Enter your name on Home first.</div>;

  return (
    <div style={styles.card}>
      <h2 style={styles.h2}>Picks: {me.first_name} {me.last_name}</h2>
      {locked && <div style={{ color: "#b91c1c", fontWeight: 800 }}>Locked — you can’t edit.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        {matchups.map(m => {
          const picked = myPicks[m.id] || null;
          return (
            <div key={m.id} style={styles.gameCard}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>{m.label || `Game ${m.game_order}`}</div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {m.start_time_utc ? `Starts: ${new Date(m.start_time_utc).toLocaleString()}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {m.winner ? `Final: ${m.score_a ?? ""}-${m.score_b ?? ""}` : ""}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                <TeamPickButton
                  label={m.team_a}
                  active={picked === "A"}
                  disabled={locked}
                  onClick={() => onPick(m.id, "A")}
                />
                <TeamPickButton
                  label={m.team_b}
                  active={picked === "B"}
                  disabled={locked}
                  onClick={() => onPick(m.id, "B")}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TeamPickButton({ label, active, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles.teamBtn,
        borderColor: active ? "#111827" : "#e5e7eb",
        background: active ? "#f3f4f6" : "#fff",
        opacity: disabled ? 0.7 : 1
      }}
    >
      {label}
    </button>
  );
}

function MyScorePage({ locked, me, matchups, allPicks }) {
  if (!locked) {
    return (
      <div style={styles.card}>
        <h2 style={styles.h2}>Not available yet</h2>
        <p style={styles.p}>Scores and public picks show after the round locks.</p>
      </div>
    );
  }
  if (!me) return <div style={styles.card}>Enter your name on Home first.</div>;

  // Compute my points (1 per correct pick)
  const my = allPicks.filter(p => p.entry_id === me.id);
  const byMatchup = new Map(matchups.map(m => [m.id, m]));
  let points = 0;
  for (const p of my) {
    const m = byMatchup.get(p.matchup_id);
    if (!m?.winner) continue;
    if (p.picked === m.winner) points += 1;
  }

  return (
    <div style={styles.card}>
      <h2 style={styles.h2}>Your Score</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={styles.statBox}>
          <div style={styles.statLabel}>Name</div>
          <div style={styles.statValueSmall}>{me.first_name} {me.last_name}</div>
        </div>
        <div style={styles.statBox}>
          <div style={styles.statLabel}>Points</div>
          <div style={styles.statValue}>{points}</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {matchups.map(m => {
          const p = my.find(x => x.matchup_id === m.id);
          const pickedSide = p?.picked;
          const pickedTeam = pickedSide ? (pickedSide === "A" ? m.team_a : m.team_b) : "(no pick)";
          const correct = m.winner ? (pickedSide === m.winner) : null;

          return (
            <div key={m.id} style={styles.gameCard}>
              <div style={{ fontWeight: 900 }}>{m.label || `Game ${m.game_order}`}</div>
              <div style={{ marginTop: 6 }}>
                Your pick: <b>{pickedTeam}</b>
              </div>
              {m.winner && (
                <div style={{ marginTop: 4 }}>
                  Result: <b>{m.winner === "A" ? m.team_a : m.team_b}</b>{" "}
                  <span style={{ opacity: 0.75 }}>({m.score_a ?? ""}-{m.score_b ?? ""})</span>
                  <div style={{ marginTop: 4, fontWeight: 900, color: correct ? "#166534" : "#b91c1c" }}>
                    {correct ? "Correct (+1)" : "Wrong (+0)"}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatsPage({ matchups, entries, allPicks }) {
  return (
    <div style={styles.card}>
      <h2 style={styles.h2}>Round Stats</h2>
      <p style={styles.p}>Percentages and names are based on submitted picks.</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {matchups.map(m => {
          const picksForMatchup = allPicks.filter(p => p.matchup_id === m.id);
          const s = computeMatchupStats(m, entries, picksForMatchup);

          return (
            <div key={m.id} style={styles.gameCard}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>{m.label || `Game ${m.game_order}`}</div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    Total picks: <b>{s.total}</b>
                  </div>
                </div>
                {m.winner && (
                  <div style={{ fontWeight: 900 }}>
                    Winner: {m.winner === "A" ? m.team_a : m.team_b}{" "}
                    <span style={{ opacity: 0.75 }}>({m.score_a ?? ""}-{m.score_b ?? ""})</span>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
                <div style={styles.statCol}>
                  <div style={{ fontWeight: 900 }}>{m.team_a}</div>
                  <div style={{ opacity: 0.8 }}>{s.aPct}% ({s.aCount})</div>
                  <div style={styles.nameList}>
                    {s.aPickers.length ? s.aPickers.join(", ") : "—"}
                  </div>
                </div>

                <div style={styles.statCol}>
                  <div style={{ fontWeight: 900 }}>{m.team_b}</div>
                  <div style={{ opacity: 0.8 }}>{s.bPct}% ({s.bCount})</div>
                  <div style={styles.nameList}>
                    {s.bPickers.length ? s.bPickers.join(", ") : "—"}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LeaderboardPage({ leaderboard }) {
  return (
    <div style={styles.card}>
      <h2 style={styles.h2}>Leaderboard</h2>
      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Rank</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Points</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.map((r, i) => (
              <tr key={r.entry_id}>
                <td style={styles.td}>{i + 1}</td>
                <td style={styles.td}>{r.name}</td>
                <td style={styles.td}><b>{r.points}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, opacity: 0.75 }}>
        Scoring: 1 point per correct pick (only games with winners entered count).
      </div>
    </div>
  );
}

function AdminPage({ contest, matchups, onUpdated }) {
  const [authed, setAuthed] = useState(localStorage.getItem(ADMIN_KEY) === "1");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");

  const [roundName, setRoundName] = useState(contest?.current_round_name || "");
  const [lockLocal, setLockLocal] = useState(contest?.round_lock_utc ? contest.round_lock_utc.slice(0, 16) : "");

  const [matchupsJson, setMatchupsJson] = useState(JSON.stringify(
    (matchups || []).map(m => ({
      game_order: m.game_order,
      label: m.label,
      team_a: m.team_a,
      team_b: m.team_b,
      start_time_utc: m.start_time_utc
    })),
    null,
    2
  ));

  const [resultsJson, setResultsJson] = useState(JSON.stringify(
    (matchups || []).map(m => ({
      id: m.id,
      winner: m.winner,
      score_a: m.score_a,
      score_b: m.score_b
    })),
    null,
    2
  ));

  function checkPw() {
    const expected = import.meta.env.VITE_ADMIN_PASSWORD || "";
    if (!expected) {
      setMsg("Set VITE_ADMIN_PASSWORD in Netlify env vars.");
      return;
    }
    if (pw === expected) {
      localStorage.setItem(ADMIN_KEY, "1");
      setAuthed(true);
      setMsg("");
    } else {
      setMsg("Wrong password.");
    }
  }

  async function saveContestSettings() {
    setMsg("");
    try {
      const patch = {
        current_round_name: roundName,
        round_lock_utc: lockLocal ? new Date(lockLocal).toISOString() : null
      };
      const up = await supabase.from("contests").update(patch).eq("id", contest.id);
      if (up.error) throw up.error;
      setMsg("Saved contest settings.");
      await onUpdated();
    } catch (e) {
      setMsg(`Save error: ${e.message}`);
    }
  }

  async function replaceMatchups() {
    setMsg("");
    try {
      const parsed = JSON.parse(matchupsJson);
      if (!Array.isArray(parsed)) throw new Error("Matchups JSON must be an array.");

      // delete existing matchups for current round, then insert new
      const del = await supabase
        .from("matchups")
        .delete()
        .eq("contest_id", contest.id)
        .eq("round_name", contest.current_round_name);

      if (del.error) throw del.error;

      const rows = parsed.map((x, idx) => ({
        contest_id: contest.id,
        round_name: roundName || contest.current_round_name,
        game_order: x.game_order ?? (idx + 1),
        label: x.label ?? null,
        team_a: x.team_a,
        team_b: x.team_b,
        start_time_utc: x.start_time_utc ?? null
      }));

      const ins = await supabase.from("matchups").insert(rows);
      if (ins.error) throw ins.error;

      setMsg("Replaced matchups for the round.");
      await onUpdated();
    } catch (e) {
      setMsg(`Replace error: ${e.message}`);
    }
  }

  async function applyResults() {
    setMsg("");
    try {
      const parsed = JSON.parse(resultsJson);
      if (!Array.isArray(parsed)) throw new Error("Results JSON must be an array.");

      for (const r of parsed) {
        if (!r.id) continue;
        if (r.winner && !["A","B"].includes(r.winner)) throw new Error(`Winner must be 'A', 'B', or null (id ${r.id})`);

        const up = await supabase.from("matchups").update({
          winner: r.winner ?? null,
          score_a: r.score_a ?? null,
          score_b: r.score_b ?? null
        }).eq("id", r.id);

        if (up.error) throw up.error;
      }

      setMsg("Applied results.");
      await onUpdated();
    } catch (e) {
      setMsg(`Results error: ${e.message}`);
    }
  }

  if (!authed) {
    return (
      <div style={styles.card}>
        <h2 style={styles.h2}>Admin</h2>
        <p style={styles.p}>Enter admin password.</p>
        <input style={styles.input} value={pw} onChange={e => setPw(e.target.value)} type="password" />
        <button style={{ ...styles.primaryBtn, marginTop: 10 }} onClick={checkPw}>Login</button>
        {msg && <div style={styles.message}>{msg}</div>}
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <h2 style={styles.h2}>Admin</h2>
      {msg && <div style={styles.message}>{msg}</div>}

      <div style={styles.row}>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Current Round Name</label>
          <input style={styles.input} value={roundName} onChange={e => setRoundName(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Round Lock (local)</label>
          <input style={styles.input} type="datetime-local" value={lockLocal} onChange={e => setLockLocal(e.target.value)} />
        </div>
      </div>

      <button style={{ ...styles.primaryBtn, marginTop: 10 }} onClick={saveContestSettings}>
        Save Round Settings
      </button>

      <hr style={{ margin: "18px 0" }} />

      <label style={styles.label}>Matchups JSON (replaces current round matchups)</label>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
        Fields: game_order, label, team_a, team_b, start_time_utc (ISO string optional)
      </div>
      <textarea style={styles.textarea} value={matchupsJson} onChange={e => setMatchupsJson(e.target.value)} />
      <button style={{ ...styles.primaryBtn, marginTop: 10 }} onClick={replaceMatchups}>
        Replace Matchups
      </button>

      <hr style={{ margin: "18px 0" }} />

      <label style={styles.label}>Results JSON (set winner/scores)</label>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
        winner: 'A' or 'B' or null. You can paste this, update winners/scores, then Apply.
      </div>
      <textarea style={styles.textarea} value={resultsJson} onChange={e => setResultsJson(e.target.value)} />
      <button style={{ ...styles.primaryBtn, marginTop: 10 }} onClick={applyResults}>
        Apply Results
      </button>
    </div>
  );
}

const styles = {
  page: { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial", padding: 16, maxWidth: 1100, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 0" },
  card: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" },
  h2: { margin: "0 0 8px 0" },
  p: { margin: "6px 0 12px 0", opacity: 0.85 },
  row: { display: "flex", gap: 12, flexWrap: "wrap" },
  label: { display: "block", fontSize: 12, fontWeight: 900, marginTop: 10, marginBottom: 6, opacity: 0.85 },
  input: { width: "100%", padding: 10, borderRadius: 10, border: "1px solid #e5e7eb" },
  textarea: { width: "100%", minHeight: 220, padding: 10, borderRadius: 10, border: "1px solid #e5e7eb", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 },
  primaryBtn: { padding: "12px 14px", borderRadius: 12, border: "1px solid #111827", background: "#111827", color: "#fff", fontWeight: 900, cursor: "pointer" },
  smallBtn: { padding: "8px 10px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", fontWeight: 800, cursor: "pointer" },
  message: { marginTop: 12, padding: 10, borderRadius: 10, background: "#fef3c7", border: "1px solid #f59e0b" },
  gameCard: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff" },
  teamBtn: { flex: 1, padding: "12px 12px", borderRadius: 12, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer", fontWeight: 900, textAlign: "left" },
  table: { borderCollapse: "collapse", width: "100%", marginTop: 10 },
  th: { textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb", fontSize: 12, opacity: 0.8 },
  td: { padding: 10, borderBottom: "1px solid #f3f4f6" },
  statBox: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, minWidth: 220 },
  statLabel: { fontSize: 12, fontWeight: 900, opacity: 0.7 },
  statValue: { fontSize: 28, fontWeight: 900 },
  statValueSmall: { fontSize: 16, fontWeight: 900 },
  statCol: { flex: 1, minWidth: 260, border: "1px solid #f3f4f6", borderRadius: 12, padding: 10, background: "#fafafa" },
  nameList: { marginTop: 6, fontSize: 12, opacity: 0.9, lineHeight: 1.4 }
};

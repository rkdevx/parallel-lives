'use client';

import { useCallback, useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const TOKEN_KEY = 'parallel-lives-admin-token';

function apiError(result, fallback) {
  if (typeof result.detail === 'string') return result.detail;
  if (Array.isArray(result.detail)) return result.detail.map((item) => item.msg || 'Invalid input').join('. ');
  return fallback;
}

export default function Page() {
  const [adminToken, setAdminToken] = useState('');
  const [overview, setOverview] = useState(null);
  const [reports, setReports] = useState([]);
  const [users, setUsers] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [groups, setGroups] = useState([]);
  const [settings, setSettings] = useState({ matching_radius_km: 40, unmask_day_threshold: 10 });
  const [userSearch, setUserSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadDashboard = useCallback(async (token) => {
    setBusy(true);
    setError('');
    try {
      const headers = { 'X-Admin-Token': token };
      const [overviewResponse, reportsResponse, usersResponse, roomsResponse, groupsResponse, settingsResponse] = await Promise.all([
        fetch(`${API_URL}/api/v1/admin/overview`, { headers }),
        fetch(`${API_URL}/api/v1/admin/reports`, { headers }),
        fetch(`${API_URL}/api/v1/admin/users`, { headers }),
        fetch(`${API_URL}/api/v1/admin/rooms`, { headers }),
        fetch(`${API_URL}/api/v1/admin/groups`, { headers }),
        fetch(`${API_URL}/api/v1/admin/settings`, { headers }),
      ]);
      const overviewData = await overviewResponse.json();
      const reportData = await reportsResponse.json();
      const usersData = await usersResponse.json();
      const roomsData = await roomsResponse.json();
      const groupsData = await groupsResponse.json();
      const settingsData = await settingsResponse.json();
      if (!overviewResponse.ok) throw new Error(apiError(overviewData, 'Could not load dashboard.'));
      if (!reportsResponse.ok) throw new Error(apiError(reportData, 'Could not load moderation reports.'));
      if (!usersResponse.ok) throw new Error(apiError(usersData, 'Could not load users.'));
      if (!roomsResponse.ok) throw new Error(apiError(roomsData, 'Could not load active rooms.'));
      if (!groupsResponse.ok) throw new Error(apiError(groupsData, 'Could not load active groups.'));
      if (!settingsResponse.ok) throw new Error(apiError(settingsData, 'Could not load system settings.'));
      setOverview(overviewData);
      setReports(reportData.reports);
      setUsers(usersData.users);
      setRooms(roomsData.rooms);
      setGroups(groupsData.groups);
      setSettings(settingsData);
      setAdminToken(token);
      localStorage.setItem(TOKEN_KEY, token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load dashboard.');
      setOverview(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const searchUsers = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/v1/admin/users?q=${encodeURIComponent(userSearch)}`, {
        headers: { 'X-Admin-Token': adminToken },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(apiError(result, 'Could not find users.'));
      setUsers(result.users);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not find users.');
    } finally {
      setBusy(false);
    }
  };

  const updateVibeScore = async (userId, value) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/api/v1/admin/users/${userId}/vibe-score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
        body: JSON.stringify({ vibe_score: Number(value) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(apiError(result, 'Could not update user score.'));
      setNotice(`Vibe score updated to ${result.vibe_score}.`);
      await loadDashboard(adminToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update user score.');
      setBusy(false);
    }
  };

  const actionUser = async (userId, action) => {
    if (action === 'hard_ban' && !window.confirm('Hard-ban this user and dissolve their active room?')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/api/v1/admin/users/${userId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
        body: JSON.stringify({ action }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(apiError(result, 'Could not update user access.'));
      setNotice(`User action applied: ${result.status.replaceAll('_', ' ')}.`);
      await loadDashboard(adminToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update user access.');
      setBusy(false);
    }
  };

  const saveSettings = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/api/v1/admin/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
        body: JSON.stringify({
          matching_radius_km: Number(settings.matching_radius_km),
          unmask_day_threshold: Number(settings.unmask_day_threshold),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(apiError(result, 'Could not save settings.'));
      setSettings(result);
      setNotice('System settings saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save settings.');
    } finally {
      setBusy(false);
    }
  };

  const dissolveRoom = async (roomId) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/api/v1/admin/rooms/${roomId}/dissolve`, {
        method: 'POST',
        headers: { 'X-Admin-Token': adminToken },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(apiError(result, 'Could not dissolve room.'));
      setNotice('Room dissolved and its active slots released.');
      await loadDashboard(adminToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not dissolve room.');
      setBusy(false);
    }
  };

  const dissolveGroup = async (groupId) => {
    if (!window.confirm('Dissolve this group room for everyone?')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/api/v1/admin/groups/${groupId}/dissolve`, {
        method: 'POST',
        headers: { 'X-Admin-Token': adminToken },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(apiError(result, 'Could not dissolve group.'));
      setNotice('Group dissolved and its active matching slots released.');
      await loadDashboard(adminToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not dissolve group.');
      setBusy(false);
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) loadDashboard(saved);
  }, [loadDashboard]);

  const takeAction = async (reportId, action) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/api/v1/admin/reports/${reportId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
        body: JSON.stringify({ action }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(apiError(result, 'Moderation action failed.'));
      setNotice(`Report updated: ${result.status.replaceAll('_', ' ')}.`);
      await loadDashboard(adminToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Moderation action failed.');
      setBusy(false);
    }
  };

  const signOut = () => {
    localStorage.removeItem(TOKEN_KEY);
    setAdminToken('');
    setOverview(null);
    setReports([]);
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PARALLEL LIVES · OPERATIONS</p>
          <h1>Care for the community.</h1>
          <p className="subtitle">Pune & PCMC · Trust, safety, and room health</p>
        </div>
        {overview && <button className="button quiet" onClick={signOut}>Sign out</button>}
      </header>

      {!overview ? (
        <form className="login card" onSubmit={(event) => { event.preventDefault(); loadDashboard(adminToken); }}>
          <h2>Admin access</h2>
          <p className="subtitle">Connect to the API using your configured admin token.</p>
          <label htmlFor="admin-token">Admin token</label>
          <input id="admin-token" type="password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Enter admin token" autoComplete="current-password" />
          {error && <p className="error">{error}</p>}
          <button className="button primary" disabled={busy || !adminToken}>{busy ? 'Connecting…' : 'Open dashboard'}</button>
          <p className="hint">Local development default: <code>dev-admin-token</code>. Change this before exposing the API.</p>
        </form>
      ) : (
        <>
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
          <section className="stats">
            {[
              ['Community members', overview.users, 'Accounts created'],
              ['Active rooms', overview.active_rooms, 'Incubations in progress'],
              ['Active small groups', overview.active_groups, 'Nearby fallback circles'],
              ['Graduated circles', overview.graduated_friendships, 'Mutual day-10 opt-ins'],
              ['Open safety reports', overview.open_reports, 'Awaiting review'],
              ['Two-way chats', overview.two_way_chats, 'Real users who have both replied'],
              ['Mutual ritual days', overview.mutual_prompt_days, 'Daily prompts completed by both'],
            ].map(([label, value, detail]) => (
              <article className="card stat" key={label}>
                <span>{label}</span><strong>{value}</strong><small>{detail}</small>
              </article>
            ))}
          </section>

          <section className="columns">
            <article className="card">
              <div className="section-head">
                <div><p className="eyebrow">LOCAL PULSE</p><h2>Neighborhoods</h2></div>
                <button className="button quiet" onClick={() => loadDashboard(adminToken)} disabled={busy}>Refresh</button>
              </div>
              {overview.neighborhoods.length ? (
                <div className="area-list">
                  {overview.neighborhoods.map((area) => (
                    <div className="area" key={area.neighborhood}>
                      <span>{area.neighborhood}</span><strong>{area.users}</strong>
                      <div className="meter"><span style={{ width: `${Math.max(4, Math.min(100, area.users * 8))}%` }} /></div>
                    </div>
                  ))}
                </div>
              ) : <p className="empty">Neighborhood activity appears as profiles join.</p>}
              <p className="hint">Counts are grouped by neighborhood label; this demo does not expose precise user coordinates.</p>
            </article>

            <article className="card">
              <div className="section-head"><div><p className="eyebrow">SAFETY</p><h2>Report queue</h2></div><span className="count">{reports.filter((report) => report.status === 'open').length} open</span></div>
              {reports.length ? (
                <div className="report-list">
                  {reports.map((report) => (
                    <div className="report" key={report.id}>
                      <div className="report-top">
                        <div><strong>@{report.reported_handle}</strong><small>Reported by @{report.reporter}</small></div>
                        <span className={report.status === 'open' ? 'status open' : 'status'}>{report.status.replaceAll('_', ' ')}</span>
                      </div>
                      <p>{report.reason}</p>
                      {report.status === 'open' && <div className="actions">
                        <button className="button quiet" disabled={busy} onClick={() => takeAction(report.id, 'dismiss')}>Dismiss</button>
                        <button className="button quiet" disabled={busy} onClick={() => takeAction(report.id, 'soft_mute')}>Soft mute</button>
                        <button className="button warning" disabled={busy} onClick={() => takeAction(report.id, 'shadow_ban')}>Shadow-ban</button>
                        <button className="button danger" disabled={busy} onClick={() => takeAction(report.id, 'hard_ban')}>Hard-ban</button>
                      </div>}
                    </div>
                  ))}
                </div>
              ) : <p className="empty">No reports yet. New reports from active rooms appear here.</p>}
            </article>
          </section>
          <section className="columns lower">
            <article className="card">
              <div className="section-head"><div><p className="eyebrow">COMMUNITY CARE</p><h2>User lookup</h2></div></div>
              <form className="search" onSubmit={(event) => { event.preventDefault(); searchUsers(); }}>
                <input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="Search handle or phone" />
                <button className="button quiet" disabled={busy}>Search</button>
              </form>
              <div className="user-list">
                {users.map((user) => (
                  <div className="user-row" key={user.id}>
                    <div>
                      <strong>@{user.anonymous_handle || 'profile incomplete'}</strong>
                      <small>{user.neighborhood_tag || 'No neighborhood'} · {user.verification_tier} · {user.is_banned ? 'banned' : user.is_shadow_banned ? 'shadow-banned' : user.is_muted ? 'muted' : 'active'}</small>
                    </div>
                    <label className="score">Vibe
                      <input aria-label={`Vibe score for ${user.anonymous_handle}`} type="number" min="0" max="100" defaultValue={user.vibe_score} onBlur={(event) => {
                        if (Number(event.target.value) !== user.vibe_score) updateVibeScore(user.id, event.target.value);
                      }} />
                    </label>
                    <div className="user-actions">
                      {(user.is_banned || user.is_shadow_banned || user.is_muted)
                        ? <button className="button quiet" disabled={busy} onClick={() => actionUser(user.id, 'restore')}>Restore</button>
                        : <>
                          <button className="button quiet" disabled={busy} onClick={() => actionUser(user.id, 'soft_mute')}>Mute</button>
                          <button className="button warning" disabled={busy} onClick={() => actionUser(user.id, 'shadow_ban')}>Shadow-ban</button>
                          <button className="button danger" disabled={busy} onClick={() => actionUser(user.id, 'hard_ban')}>Ban</button>
                        </>}
                    </div>
                  </div>
                ))}
                {!users.length && <p className="empty">No matching community members.</p>}
              </div>
            </article>
            <article className="card">
              <div className="section-head"><div><p className="eyebrow">ROOM HEALTH</p><h2>Active rooms</h2></div><span className="count">{rooms.length} active</span></div>
              <div className="report-list">
                {rooms.map((room) => (
                  <div className="room-row" key={room.room_id}>
                    <div><strong>@{room.user1_handle} + @{room.user2_handle}</strong><small>Room {room.room_id.slice(0, 8)}</small></div>
                    <button className="button danger" disabled={busy} onClick={() => dissolveRoom(room.room_id)}>Dissolve</button>
                  </div>
                ))}
                {!rooms.length && <p className="empty">There are no active rooms.</p>}
              </div>
              <div className="section-head group-list-head">
                <div><p className="eyebrow">GROUP FALLBACK</p><h2>Small circles</h2></div>
                <span className="count">{groups.length} active</span>
              </div>
              <div className="report-list">
                {groups.map((group) => (
                  <div className="room-row" key={group.group_id}>
                    <div><strong>{group.member_handles}</strong><small>{group.member_count} people · Group {group.group_id.slice(0, 8)}</small></div>
                    <button className="button danger" disabled={busy} onClick={() => dissolveGroup(group.group_id)}>Dissolve</button>
                  </div>
                ))}
                {!groups.length && <p className="empty">No active small groups.</p>}
              </div>
            </article>
          </section>
          <section className="card config-card">
            <div><p className="eyebrow">SYSTEM CONFIGURATION</p><h2>Matching and graduation</h2><p className="hint">Matching radius is capped at 40 km. The incubation milestone controls when mutual opt-in opens.</p></div>
            <form className="settings-form" onSubmit={saveSettings}>
              <label>Matching radius (km)<input type="number" min="1" max="40" value={settings.matching_radius_km} onChange={(event) => setSettings({ ...settings, matching_radius_km: event.target.value })} /></label>
              <label>Unmask day<input type="number" min="1" max="30" value={settings.unmask_day_threshold} onChange={(event) => setSettings({ ...settings, unmask_day_threshold: event.target.value })} /></label>
              <button className="button primary" disabled={busy}>Save settings</button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}

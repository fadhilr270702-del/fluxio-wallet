import React, { useEffect, useState } from 'react';
import useAuth from '../../hooks/useAuth.js';
import { getAdmins, updateAdmin } from '../../services/adminsApi.js';
import { formatDate } from '../../utils/formatDate.js';

export default function AdminsPage() {
  const { admin: currentAdmin } = useAuth();
  const [admins, setAdmins] = useState(null);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);

  useEffect(() => {
    load();
  }, []);

  function load() {
    getAdmins()
      .then((data) => setAdmins(data.admins))
      .catch(() => setError('Could not load admins.'));
  }

  async function handleRoleChange(id, role) {
    setSavingId(id);
    setError(null);
    try {
      await updateAdmin(id, { role });
      load();
    } catch (err) {
      setError(err.message || 'Could not update role.');
    } finally {
      setSavingId(null);
    }
  }

  async function handleToggleActive(id, isActive) {
    setSavingId(id);
    setError(null);
    try {
      await updateAdmin(id, { isActive: !isActive });
      load();
    } catch (err) {
      setError(err.message || 'Could not update status.');
    } finally {
      setSavingId(null);
    }
  }

  if (error && !admins) return <div className="form-error">{error}</div>;
  if (!admins) return <div className="loading-state">Loading…</div>;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Settings — Admins</h1>
          <p className="page-head__desc">
            Change an existing admin's role or active status. New admins are created via the
            backend CLI only (<code>pnpm --filter backend create-admin</code>) — there's no
            self-serve signup, by design.
          </p>
        </div>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => {
              const isSelf = a.id === currentAdmin.id;
              const disabled = isSelf || savingId === a.id;
              return (
                <tr key={a.id}>
                  <td className="data-table__title">
                    {a.email}
                    {isSelf && <span className="data-table__meta"> (you)</span>}
                  </td>
                  <td>
                    <select value={a.role} disabled={disabled} onChange={(e) => handleRoleChange(a.id, e.target.value)}>
                      <option value="superadmin">superadmin</option>
                      <option value="editor">editor</option>
                    </select>
                  </td>
                  <td>
                    <span className={`badge badge--${a.isActive ? 'published' : 'draft'}`}>
                      {a.isActive ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="data-table__meta">{formatDate(a.createdAt)}</td>
                  <td>
                    <div className="data-table__actions">
                      <button className="btn btn-sm" disabled={disabled} onClick={() => handleToggleActive(a.id, a.isActive)}>
                        {a.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}

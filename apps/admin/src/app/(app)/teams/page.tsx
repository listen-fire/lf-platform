'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import type { OpsDetailLevel } from '#trpc';
import {
  PageHeader,
  PageBody,
  PageIntro,
  Button,
  Badge,
  EmptyState,
} from '@/components/ui';

// ─── Shared input / button class mirror from web settings ─────────────
/** A member's level on a team: each holds everything the one below it does; an admin also manages the team. */
type TeamAccess = 'read' | 'write' | 'admin';

/** A select's value as a level; only the options it offers can arrive. */
function teamAccessOf(value: string): TeamAccess {
  return value === 'admin' || value === 'read' ? value : 'write';
}

const inputClass =
  'w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none disabled:opacity-50';
const selectClass =
  'rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none disabled:opacity-50';

// ─── Inline error banner ───────────────────────────────────────────────
function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
      {message}
    </div>
  );
}

// ─── Success flash ─────────────────────────────────────────────────────
function SuccessFlash({ message }: { message: string }) {
  return (
    <span className="text-[12px] text-emerald-600">{message}</span>
  );
}

// ─── Field label ───────────────────────────────────────────────────────
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-[12px] text-gray-500">{children}</label>;
}

// ─── Sub-panel heading inside a detail card ────────────────────────────
function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
      {children}
    </div>
  );
}

// ─── Searchable team picker (paginated — never fetches every team) ─────
function TeamPicker({
  value,
  onChange,
  disabled,
  placeholder = 'Select team…',
}: {
  value: string;
  onChange: (teamId: string, teamName: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [label, setLabel] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Debounce the typed search term.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // When the parent clears the value (e.g. after a successful submit), drop
  // the shown label too.
  useEffect(() => {
    if (!value) setLabel('');
  }, [value]);

  // Dismiss the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const { data, isFetching } = trpc.views.admin.crossTeamOps.listTeams.useQuery(
    { search: debounced || undefined, limit: 20, offset: 0 },
    { enabled: open },
  );

  const select = (id: string, name: string) => {
    setLabel(name);
    setOpen(false);
    setQuery('');
    onChange(id, name);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`${selectClass} flex w-full items-center justify-between text-left ${
          value ? 'text-gray-800' : 'text-gray-400'
        }`}
      >
        <span className="truncate">{value ? label || 'Selected team' : placeholder}</span>
        <span className="ml-2 shrink-0 text-gray-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 p-2">
            <input
              autoFocus
              className={inputClass}
              placeholder="Search teams…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {isFetching && (!data || data.items.length === 0) ? (
              <div className="px-3 py-2 text-[12px] text-gray-400">Searching…</div>
            ) : !data || data.items.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-gray-400">No teams found.</div>
            ) : (
              data.items.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => select(t.id, t.name)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-gray-50 ${
                    t.id === value ? 'bg-gray-50 font-medium text-gray-900' : 'text-gray-700'
                  }`}
                >
                  <span className="flex-1 truncate">{t.name}</span>
                  <span className="font-mono text-[10px] text-gray-300">{t.id.slice(0, 8)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Create team modal ─────────────────────────────────────────────────
function CreateTeamModal({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const { mutateAsync: createTeam } = trpc.views.admin.userManagement.createTeamWithAdmin.useMutation();

  const [teamName, setTeamName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminUsername, setAdminUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!teamName.trim() || !adminEmail.trim() || !adminUsername.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createTeam({
        teamName: teamName.trim(),
        users: [{ email: adminEmail.trim(), username: adminUsername.trim() }],
      });
      utils.views.admin.crossTeamOps.listTeams.invalidate();
      utils.views.admin.userManagement.getTeams.invalidate();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, [createTeam, teamName, adminEmail, adminUsername, utils, onClose]);

  const canSubmit = teamName.trim() && adminEmail.trim() && adminUsername.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-100 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-gray-900">Create team</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <div>
            <FieldLabel>Team name</FieldLabel>
            <input
              autoFocus
              className={inputClass}
              placeholder="Acme VC"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <FieldLabel>Admin email</FieldLabel>
            <input
              className={inputClass}
              type="email"
              placeholder="admin@acme.com"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <FieldLabel>Admin username</FieldLabel>
            <input
              className={inputClass}
              placeholder="Alice"
              value={adminUsername}
              onChange={(e) => setAdminUsername(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="mt-1 flex items-center gap-3">
            <Button variant="primary" onClick={submit} disabled={busy || !canSubmit}>
              {busy ? 'Creating…' : 'Create team'}
            </Button>
          </div>
          {error && <ErrorBanner message={error} />}
        </div>
      </div>
    </div>
  );
}

// ─── Ops feed detail level (one team) ──────────────────────────────────
function TeamDetailLevelControl({ team }: { team: TeamResult }) {
  const utils = trpc.useUtils();
  const { mutateAsync: setDetailLevel } =
    trpc.views.admin.userManagement.setTeamDetailLevel.useMutation();

  const [level, setLevel] = useState<string>(team.ops_detail_level);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleChange = useCallback(
    async (next: string) => {
      setLevel(next);
      setBusy(true);
      setError(null);
      setSuccess(null);
      try {
        await setDetailLevel({ teamId: team.id, level: next as OpsDetailLevel });
        setSuccess('Saved');
        utils.views.admin.crossTeamOps.listTeams.invalidate();
      } catch (e: unknown) {
        setLevel(team.ops_detail_level);
        setError(e instanceof Error ? e.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [setDetailLevel, team.id, team.ops_detail_level, utils],
  );

  return (
    <div>
      <PanelHeading>Ops feed detail level</PanelHeading>
      <div className="flex items-center gap-3">
        <select
          className={selectClass}
          value={level}
          disabled={busy}
          onChange={(e) => handleChange(e.target.value)}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="full">Full</option>
        </select>
        {success && <SuccessFlash message={success} />}
      </div>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

// ─── Add user to team (one team) ───────────────────────────────────────
function AddUserToTeamForm({ team }: { team: TeamResult }) {
  const { mutateAsync: addUser } = trpc.views.admin.userManagement.addUserToTeam.useMutation();

  const [access, setAccess] = useState<TeamAccess>('write');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!email.trim() || !username.trim()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await addUser({
        teamId: team.id,
        access,
        email: email.trim(),
        username: username.trim(),
      });
      setEmail('');
      setUsername('');
      setSuccess(`User "${result.username}" added`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, [addUser, team.id, access, email, username]);

  const canSubmit = email.trim() && username.trim();

  return (
    <div className="border-t border-gray-100 pt-4">
      <PanelHeading>Add user</PanelHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <FieldLabel>Access</FieldLabel>
          <select
            className={`${selectClass} w-full`}
            value={access}
            onChange={(e) => setAccess(teamAccessOf(e.target.value))}
            disabled={busy}
          >
            <option value="admin">Admin</option>
            <option value="write">Write</option>
            <option value="read">Read-only</option>
          </select>
        </div>
        <div>
          <FieldLabel>Email</FieldLabel>
          <input
            className={inputClass}
            type="email"
            placeholder="user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <FieldLabel>Username</FieldLabel>
          <input
            className={inputClass}
            placeholder="Bob"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" onClick={submit} disabled={busy || !canSubmit}>
          {busy ? 'Adding…' : 'Add user'}
        </Button>
        {success && <SuccessFlash message={success} />}
      </div>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

// ─── Team detail panel ─────────────────────────────────────────────────
type TeamResult =
  RouterOutputs['views']['admin']['crossTeamOps']['listTeams']['items'][number];

function TeamDetail({ team, onDismiss }: { team: TeamResult; onDismiss: () => void }) {
  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-gray-900">{team.name}</div>
          <div className="mt-0.5 font-mono text-[11px] text-gray-400">{team.id}</div>
        </div>
        <button
          onClick={onDismiss}
          className="text-[12px] text-gray-400 hover:text-gray-700"
        >
          Dismiss
        </button>
      </div>

      <div className="space-y-4">
        <TeamDetailLevelControl team={team} />
        <AddUserToTeamForm team={team} />
      </div>
    </div>
  );
}

// ─── User detail panel ─────────────────────────────────────────────────
type SearchResult = {
  id: string;
  username: string;
  teamId: string;
  team: { name: string };
  emails: { email: string }[];
};

function UserDetail({
  user,
  onDismiss,
}: {
  user: SearchResult;
  onDismiss: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: contactInfo, isLoading } =
    trpc.views.admin.userManagement.getUserContactInfo.useQuery({ userId: user.id });
  const { data: memberships } =
    trpc.views.admin.userManagement.listUserMemberships.useQuery({ userId: user.id });

  const { mutateAsync: grantAccess } = trpc.views.admin.userManagement.grantTeamAccess.useMutation();
  const { mutateAsync: updateUsername } = trpc.views.admin.userManagement.updateUsername.useMutation();
  const { mutateAsync: addEmail } = trpc.views.admin.userManagement.addEmailToUser.useMutation();
  const { mutateAsync: addPhone } = trpc.views.admin.userManagement.addPhoneNumberToUser.useMutation();
  const { mutateAsync: removeFromTeam } = trpc.views.admin.userManagement.removeUserFromTeam.useMutation();

  const refetchContactInfo = useCallback(
    () => utils.views.admin.userManagement.getUserContactInfo.invalidate({ userId: user.id }),
    [utils, user.id],
  );
  const refetchMemberships = useCallback(
    () => utils.views.admin.userManagement.listUserMemberships.invalidate({ userId: user.id }),
    [utils, user.id],
  );

  // ── Name edit ──────────────────────────────────────────────────────
  const [nameValue, setNameValue] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSuccess, setNameSuccess] = useState<string | null>(null);

  // Sync nameValue when contactInfo loads
  useEffect(() => {
    if (contactInfo) setNameValue(contactInfo.username);
  }, [contactInfo]);

  const handleSaveName = useCallback(async () => {
    if (!nameValue.trim()) return;
    setNameBusy(true);
    setNameError(null);
    setNameSuccess(null);
    try {
      await updateUsername({ userId: user.id, username: nameValue.trim() });
      setNameSuccess('Name saved');
      await refetchContactInfo();
    } catch (e: unknown) {
      setNameError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setNameBusy(false);
    }
  }, [updateUsername, user.id, nameValue, refetchContactInfo]);

  // ── Add email ──────────────────────────────────────────────────────
  const [newEmail, setNewEmail] = useState('');
  const [newEmailPrimary, setNewEmailPrimary] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);

  const handleAddEmail = useCallback(async () => {
    if (!newEmail.trim()) return;
    setEmailBusy(true);
    setEmailError(null);
    setEmailSuccess(null);
    try {
      await addEmail({ userId: user.id, email: newEmail.trim(), isPrimary: newEmailPrimary });
      setEmailSuccess(`Added ${newEmail.trim()}`);
      setNewEmail('');
      setNewEmailPrimary(false);
      await refetchContactInfo();
    } catch (e: unknown) {
      setEmailError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setEmailBusy(false);
    }
  }, [addEmail, user.id, newEmail, newEmailPrimary, refetchContactInfo]);

  // ── Phone ──────────────────────────────────────────────────────────
  const [phoneValue, setPhoneValue] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSuccess, setPhoneSuccess] = useState<string | null>(null);

  const handleSavePhone = useCallback(async () => {
    if (!phoneValue.trim()) return;
    setPhoneBusy(true);
    setPhoneError(null);
    setPhoneSuccess(null);
    try {
      await addPhone({ userId: user.id, phoneNumber: phoneValue.trim() });
      setPhoneSuccess('Phone saved');
      setPhoneValue('');
      await refetchContactInfo();
    } catch (e: unknown) {
      setPhoneError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setPhoneBusy(false);
    }
  }, [addPhone, user.id, phoneValue, refetchContactInfo]);

  // ── Team memberships (remove) ──────────────────────────────────────
  const [removeBusy, setRemoveBusy] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleRemove = useCallback(
    async (teamId: string, teamName: string) => {
      if (
        !window.confirm(
          `Remove ${user.username} from "${teamName}"? They'll lose access to this team.`,
        )
      ) {
        return;
      }
      setRemoveBusy(teamId);
      setRemoveError(null);
      try {
        await removeFromTeam({ teamId, userId: user.id });
        await refetchMemberships();
      } catch (e: unknown) {
        setRemoveError(e instanceof Error ? e.message : 'Something went wrong');
      } finally {
        setRemoveBusy(null);
      }
    },
    [removeFromTeam, user.id, user.username, refetchMemberships],
  );

  // ── Grant team access ──────────────────────────────────────────────
  const [grantTeamId, setGrantTeamId] = useState('');
  const [grantAccessLevel, setGrantAccessLevel] = useState<TeamAccess>('write');
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantSuccess, setGrantSuccess] = useState<string | null>(null);

  const handleGrant = useCallback(async () => {
    if (!grantTeamId) return;
    setGrantBusy(true);
    setGrantError(null);
    setGrantSuccess(null);
    try {
      const result = await grantAccess({
        userId: user.id,
        teamId: grantTeamId,
        access: grantAccessLevel,
      });
      setGrantSuccess(`Granted ${result.access} on "${result.teamName}" to ${result.username}`);
      setGrantTeamId('');
      await refetchMemberships();
    } catch (e: unknown) {
      setGrantError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setGrantBusy(false);
    }
  }, [grantAccess, user.id, grantTeamId, grantAccessLevel, refetchMemberships]);

  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-gray-900">{user.username}</div>
          <div className="mt-0.5 text-[12px] text-gray-400">{user.team.name}</div>
        </div>
        <button
          onClick={onDismiss}
          className="text-[12px] text-gray-400 hover:text-gray-700"
        >
          Dismiss
        </button>
      </div>

      {isLoading ? (
        <div className="h-24 animate-pulse rounded-lg bg-gray-100" />
      ) : contactInfo ? (
        <div className="space-y-5">
          {/* Name */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Name
            </div>
            <div className="flex items-center gap-2">
              <input
                className={`${inputClass} flex-1`}
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                disabled={nameBusy}
                placeholder="Display name"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveName}
                disabled={nameBusy || !nameValue.trim() || nameValue.trim() === contactInfo.username}
              >
                {nameBusy ? 'Saving…' : 'Save'}
              </Button>
            </div>
            {nameSuccess && <div className="mt-1"><SuccessFlash message={nameSuccess} /></div>}
            {nameError && <ErrorBanner message={nameError} />}
          </div>

          {/* Emails */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Emails
            </div>
            <div className="space-y-1.5">
              {contactInfo.emails.map((e) => (
                <div
                  key={e.id}
                  className="rounded-md bg-gray-50 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="flex-1 text-[13px] text-gray-800">{e.email}</span>
                    <div className="flex flex-wrap gap-1">
                      {e.isPrimary && <Badge tone="blue">primary</Badge>}
                      {e.isServiceEmail && <Badge tone="violet">service</Badge>}
                      {e.acceptsPlusAddressing && <Badge tone="gray">+addressing</Badge>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* Add email */}
            <div className="mt-3 rounded-md border border-dashed border-gray-200 p-3">
              <div className="mb-2 text-[11px] text-gray-400">Add email</div>
              <div className="flex items-center gap-2">
                <input
                  className={`${inputClass} flex-1`}
                  type="email"
                  placeholder="new@example.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  disabled={emailBusy}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAddEmail}
                  disabled={emailBusy || !newEmail.trim()}
                >
                  {emailBusy ? 'Adding…' : 'Add'}
                </Button>
              </div>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-gray-500">
                <input
                  type="checkbox"
                  checked={newEmailPrimary}
                  onChange={(e) => setNewEmailPrimary(e.target.checked)}
                  disabled={emailBusy}
                  className="rounded border-gray-300"
                />
                Set as primary
              </label>
              {emailSuccess && <div className="mt-1"><SuccessFlash message={emailSuccess} /></div>}
              {emailError && <ErrorBanner message={emailError} />}
            </div>
          </div>

          {/* Phone */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Phone
            </div>
            {contactInfo.phoneNumber && (
              <div className="mb-2 rounded-md bg-gray-50 px-3 py-2 text-[13px] text-gray-800">
                {contactInfo.phoneNumber.phoneNumber}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                className={`${inputClass} flex-1`}
                type="tel"
                placeholder={contactInfo.phoneNumber ? 'New number to replace…' : '+44 7700 900000'}
                value={phoneValue}
                onChange={(e) => setPhoneValue(e.target.value)}
                disabled={phoneBusy}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSavePhone}
                disabled={phoneBusy || !phoneValue.trim()}
              >
                {phoneBusy ? 'Saving…' : contactInfo.phoneNumber ? 'Update' : 'Add'}
              </Button>
            </div>
            {phoneSuccess && <div className="mt-1"><SuccessFlash message={phoneSuccess} /></div>}
            {phoneError && <ErrorBanner message={phoneError} />}
          </div>

          {/* Team memberships */}
          <div className="border-t border-gray-100 pt-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Team memberships
            </div>
            {!memberships || memberships.length === 0 ? (
              <div className="text-[12px] text-gray-400">No team memberships.</div>
            ) : (
              <div className="space-y-1.5">
                {memberships.map((m) => {
                  const locked = m.isHomeTeam || m.isPersonal;
                  return (
                    <div
                      key={m.teamId}
                      className="flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2"
                    >
                      <span className="flex-1 truncate text-[13px] text-gray-800">
                        {m.teamName}
                      </span>
                      <Badge tone={m.access === 'read' ? 'gray' : 'blue'}>
                        {m.access}
                      </Badge>
                      {m.isHomeTeam && <Badge tone="violet">home</Badge>}
                      {m.isPersonal && <Badge tone="amber">personal</Badge>}
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={locked || removeBusy === m.teamId}
                        title={
                          locked
                            ? 'Move the user to another team before removing their home / personal team'
                            : undefined
                        }
                        onClick={() => handleRemove(m.teamId, m.teamName)}
                      >
                        {removeBusy === m.teamId ? 'Removing…' : 'Remove'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {removeError && <ErrorBanner message={removeError} />}
          </div>

          {/* Grant team access */}
          <div className="border-t border-gray-100 pt-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Grant team access
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <TeamPicker
                  value={grantTeamId}
                  onChange={(id) => setGrantTeamId(id)}
                  disabled={grantBusy}
                />
              </div>
              <select
                className={selectClass}
                value={grantAccessLevel}
                onChange={(e) => setGrantAccessLevel(teamAccessOf(e.target.value))}
                disabled={grantBusy}
              >
                <option value="admin">Admin</option>
                <option value="write">Write</option>
                <option value="read">Read</option>
              </select>
              <Button
                variant="primary"
                onClick={handleGrant}
                disabled={grantBusy || !grantTeamId}
              >
                {grantBusy ? 'Granting…' : 'Grant'}
              </Button>
            </div>
            {grantSuccess && (
              <div className="mt-2">
                <SuccessFlash message={grantSuccess} />
              </div>
            )}
            {grantError && <ErrorBanner message={grantError} />}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Unified search (teams + users) ────────────────────────────────────
type Selection =
  | { kind: 'team'; team: TeamResult }
  | { kind: 'user'; user: SearchResult };

function ResultGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 bg-gray-50 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
      {children}
    </div>
  );
}

function AdminSearch() {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teamsQuery = trpc.views.admin.crossTeamOps.listTeams.useQuery(
    { search: submitted, limit: 50, offset: 0 },
    { enabled: submitted.length > 0 },
  );
  const usersQuery = trpc.views.admin.userManagement.searchUsersByEmail.useQuery(
    { emailPrefix: submitted },
    { enabled: submitted.length > 0 },
  );

  const handleChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length === 0) {
      setSubmitted('');
      return;
    }
    debounceRef.current = setTimeout(() => {
      setSubmitted(value.trim());
    }, 350);
  };

  const teams = teamsQuery.data?.items ?? [];
  const users = usersQuery.data ?? [];
  const loading = teamsQuery.isLoading || usersQuery.isLoading;

  return (
    <>
      <input
        className={inputClass}
        placeholder="Search teams by name, users by email…"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
      />

      {submitted && (
        <div className="mt-3">
          {loading ? (
            <div className="space-y-1.5">
              {[1, 2].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-xl bg-gray-100" />
              ))}
            </div>
          ) : teams.length === 0 && users.length === 0 ? (
            <EmptyState
              title="Nothing found"
              caption={`No teams or users matching "${submitted}".`}
            />
          ) : (
            <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-gray-100">
              {teams.length > 0 && (
                <div>
                  <ResultGroupLabel>Teams</ResultGroupLabel>
                  <div className="divide-y divide-gray-100">
                    {teams.map((t) => {
                      const isSelected = selected?.kind === 'team' && selected.team.id === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setSelected(isSelected ? null : { kind: 'team', team: t })}
                          className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 ${
                            isSelected ? 'bg-gray-50' : ''
                          }`}
                        >
                          <span className="flex-1 truncate text-[13px] text-gray-800">{t.name}</span>
                          <span className="font-mono text-[11px] text-gray-400">
                            {t.id.slice(0, 8)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {users.length > 0 && (
                <div className={teams.length > 0 ? 'border-t border-gray-100' : ''}>
                  <ResultGroupLabel>Users</ResultGroupLabel>
                  <div className="divide-y divide-gray-100">
                    {users.map((u) => {
                      const isSelected = selected?.kind === 'user' && selected.user.id === u.id;
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => setSelected(isSelected ? null : { kind: 'user', user: u })}
                          className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 ${
                            isSelected ? 'bg-gray-50' : ''
                          }`}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="truncate text-[13px] text-gray-800">{u.username}</span>
                            <span className="truncate text-[12px] text-gray-400">
                              {u.emails[0]?.email}
                            </span>
                          </div>
                          <Badge tone="gray">{u.team.name}</Badge>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {selected?.kind === 'team' && (
        <div className="mt-4">
          <TeamDetail
            key={selected.team.id}
            team={selected.team}
            onDismiss={() => setSelected(null)}
          />
        </div>
      )}
      {selected?.kind === 'user' && (
        <div className="mt-4">
          <UserDetail
            key={selected.user.id}
            user={selected.user}
            onDismiss={() => setSelected(null)}
          />
        </div>
      )}
    </>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────
export default function TeamsPage() {
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Teams"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            Create team
          </Button>
        }
      />
      <PageBody width="wide">
        <PageIntro>
          Search for a team to configure its ops feed and members,
          or for a user to manage their contact details and team access.
        </PageIntro>

        <AdminSearch />
      </PageBody>
      {creating && <CreateTeamModal onClose={() => setCreating(false)} />}
    </>
  );
}

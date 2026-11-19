import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import {
  Contact,
  ContactField,
  ContactsSortOrder,
  getPermissionsAsync,
  requestPermissionsAsync,
} from 'expo-contacts';
import {
  CACHED_CONTACTS_DISPLAY_LIMIT,
  cleanPhone,
  filterContacts,
  hasPlanDrifted,
  mergeSelectedContacts,
  planContactImport,
  summarizeCachedContactsView,
  type StagingPlan,
} from '../domain/contacts';
import type { SyncedContact } from '../domain/types';
import { useApp } from '../state/AppProvider';
import { Banner, Button, Card, ConfirmButton, ExpandableSection, Field } from './components';
import { type as typography, useTheme } from './theme';

const BATCH_SIZE = 200;
const FIELDS = [ContactField.FULL_NAME, ContactField.PHONES, ContactField.EMAILS, ContactField.IMAGE] as const;

export default function ContactsSync() {
  const app = useApp();
  const { c } = useTheme();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [search, setSearch] = useState('');

  // Staging / review state for native import
  const [stagedPlan, setStagedPlan] = useState<StagingPlan | null>(null);
  const [rawFetched, setRawFetched] = useState<SyncedContact[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [candidateFilter, setCandidateFilter] = useState('');

  const contacts = useMemo(
    () => [...app.data.syncedContacts].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [app.data.syncedContacts],
  );

  const matchedContacts = useMemo(
    () => filterContacts(contacts, search),
    [contacts, search],
  );

  const visible = useMemo(
    () => matchedContacts.slice(0, CACHED_CONTACTS_DISPLAY_LIMIT),
    [matchedContacts],
  );

  const searchSummary = useMemo(
    () =>
      summarizeCachedContactsView(
        contacts.length,
        matchedContacts.length,
        visible.length,
        search,
      ),
    [contacts.length, matchedContacts.length, visible.length, search],
  );

  // Filtered candidate list in staging view
  const candidateQuery = candidateFilter.trim().toLocaleLowerCase();
  const filteredCandidates = useMemo(() => {
    if (!stagedPlan) return [];
    if (!candidateQuery) return stagedPlan.candidates;
    return stagedPlan.candidates.filter((cand) =>
      `${cand.contact.fullName} ${cand.contact.phones.join(' ')} ${cand.contact.emails.join(' ')}`
        .toLocaleLowerCase()
        .includes(candidateQuery),
    );
  }, [stagedPlan, candidateQuery]);

  async function startNativeRefresh() {
    if (busy || saving) return;
    setBusy(true);
    setMessage(null);

    try {
      const current = await getPermissionsAsync();
      const permission = current.granted ? current : await requestPermissionsAsync();
      if (!permission.granted) {
        if (isMountedRef.current) {
          setMessage({
            tone: 'danger',
            text: 'Contacts permission was not granted. The existing local cache was kept unchanged.',
          });
        }
        return;
      }

      const syncedAt = new Date().toISOString();
      const fetched: SyncedContact[] = [];

      for (let offset = 0; ; offset += BATCH_SIZE) {
        const page = await Contact.getAllDetails(FIELDS, {
          limit: BATCH_SIZE,
          offset,
          sortOrder: ContactsSortOrder.GivenName,
        });

        fetched.push(
          ...page.map((contact) => ({
            id: contact.id,
            fullName: contact.fullName?.trim() ?? '',
            phones: contact.phones.map((phone) => cleanPhone(phone.number ?? '')).filter(Boolean),
            emails: contact.emails.map((email) => email.address?.trim() ?? '').filter(Boolean),
            photoUri: contact.image ?? null,
            syncedAt,
          })),
        );

        if (page.length < BATCH_SIZE) break;
      }

      const plan = planContactImport(app.data.syncedContacts, fetched);

      if (isMountedRef.current) {
        setRawFetched(fetched);
        setStagedPlan(plan);
        // Default selection: select all candidates except conflicts
        setSelectedIds(
          new Set(
            plan.candidates
              .filter((c) => c.status !== 'conflict')
              .map((c) => c.contact.id),
          ),
        );
        setCandidateFilter('');
        const limited = permission.accessPrivileges === 'limited';
        setMessage({
          tone: 'info',
          text: `Found ${plan.candidates.length} contacts on device${limited ? ' - limited by iOS permission' : ''}${plan.conflictCount ? ` - ${plan.conflictCount} ID collisions flagged` : ''}. Review and select which ones to import below.`,
        });
      }
    } catch (error) {
      if (isMountedRef.current) {
        setMessage({
          tone: 'danger',
          text: error instanceof Error
            ? `Could not read device contacts: ${error.message}. The existing cache was kept.`
            : 'Could not read device contacts. The existing cache was kept.',
        });
      }
    } finally {
      if (isMountedRef.current) {
        setBusy(false);
      }
    }
  }

  async function applyStagedImport() {
    if (!stagedPlan || !rawFetched || saving) return;
    setSaving(true);
    setMessage(null);

    try {
      // 1. Apply-Time Revalidation against live current cache
      const freshPlan = planContactImport(app.data.syncedContacts, rawFetched);

      // Check candidate-by-candidate if status, target ID, diffs, or counts drifted from what was previewed
      if (hasPlanDrifted(stagedPlan, freshPlan)) {
        if (isMountedRef.current) {
          setStagedPlan(freshPlan);
          setSelectedIds((prev) => {
            const allowed = new Set(
              freshPlan.candidates
                .filter((c) => c.status !== 'conflict')
                .map((c) => c.contact.id),
            );
            const next = new Set<string>();
            for (const id of prev) {
              if (allowed.has(id)) next.add(id);
            }
            return next;
          });
          setMessage({
            tone: 'danger',
            text: 'The local contacts cache changed while reviewing. Candidates were revalidated against latest data. Please review the updated plan before confirming.',
          });
        }
        return;
      }

      const selectedCandidates = freshPlan.candidates.filter((c) =>
        selectedIds.has(c.contact.id),
      );

      const { merged, addedCount, updatedCount, skippedConflictCount } = mergeSelectedContacts(
        app.data.syncedContacts,
        selectedCandidates,
      );

      const error = await app.replaceSyncedContacts(merged);

      if (error) {
        if (isMountedRef.current) {
          setMessage({
            tone: 'danger',
            text: `Could not save contacts: ${error}. Prior cache kept.`,
          });
        }
        return;
      }

      if (isMountedRef.current) {
        setStagedPlan(null);
        setRawFetched(null);
        setSelectedIds(new Set());
        setCandidateFilter('');
        setMessage({
          tone: 'info',
          text: `Import complete: added ${addedCount} new, updated ${updatedCount} existing.${skippedConflictCount ? ` Skipped ${skippedConflictCount} conflicting contacts to protect existing records.` : ''} Total cached contacts: ${merged.length}. Unselected records were preserved.`,
        });
      }
    } catch (err) {
      if (isMountedRef.current) {
        setMessage({
          tone: 'danger',
          text: err instanceof Error
            ? `Failed to apply import: ${err.message}. Prior cache kept.`
            : 'Failed to apply import. Prior cache kept.',
        });
      }
    } finally {
      if (isMountedRef.current) {
        setSaving(false);
      }
    }
  }

  function toggleCandidate(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllCandidates() {
    if (!stagedPlan) return;
    setSelectedIds(new Set(stagedPlan.candidates.map((c) => c.contact.id)));
  }

  function deselectAllCandidates() {
    setSelectedIds(new Set());
  }

  function selectNewAndUpdatesOnly() {
    if (!stagedPlan) return;
    setSelectedIds(
      new Set(
        stagedPlan.candidates
          .filter((c) => c.status !== 'identical')
          .map((c) => c.contact.id),
      ),
    );
  }

  return (
    <ExpandableSection title="Device contacts">

      {/* 1. Platform-Specific Action Header */}
      {Platform.OS === 'web' ? (
        <Card>
          <Text style={[typography.body, { color: c.sub }]}>
            The phone address book is available only in the mobile app (iOS and Android). Contacts restored from a backup can be viewed, searched, and managed here. They do not sync between devices automatically.
          </Text>
        </Card>
      ) : (
        <Card>
          <Text style={{ color: c.sub, marginBottom: 8, fontSize: 14 }}>
            Refresh reads contact names, phone numbers, emails, and photo URIs after you tap the
            button and grant OS permission. Data stays on this device only. Refresh is manual while
            Personal Assistant is open; there is no background collection.
          </Text>
          {!stagedPlan ? (
            <Button
              label={busy ? 'Reading device contacts…' : 'Refresh contacts now'}
              disabled={busy || saving}
              onPress={() => {
                void startNativeRefresh();
              }}
            />
          ) : null}
        </Card>
      )}

      {/* Global / Operation Message */}
      {message ? (
        <Banner text={message.text} tone={message.tone} />
      ) : null}

      {/* 2. Native Import Staging & Review View */}
      {stagedPlan ? (
        <Card>
          <Text style={{ color: c.text, fontWeight: '700', fontSize: 16, marginBottom: 4 }}>
            Review contacts to import
          </Text>
          <Text style={{ color: c.sub, fontSize: 14, marginBottom: 8 }}>
            Found {stagedPlan.candidates.length} candidates ({stagedPlan.newCount} new, {stagedPlan.updateCount} updates, {stagedPlan.identicalCount} identical{stagedPlan.conflictCount ? `, ${stagedPlan.conflictCount} conflicts` : ''}).
            {'\n'}
            Currently selected: {selectedIds.size} of {stagedPlan.candidates.length} (contacts you don&apos;t select are left as they are).
          </Text>
          {stagedPlan.conflictCount > 0 ? (
            <Text style={{ color: c.danger, fontSize: 13, marginBottom: 8 }}>
              ⚠️ {stagedPlan.conflictCount} contact{stagedPlan.conflictCount > 1 ? 's have' : ' has an'} ID collision with existing records having different names/numbers. Conflicting items are blocked from overwriting and will be skipped.
            </Text>
          ) : null}

          {/* Bulk Selection Controls */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            <Button
              kind="secondary"
              label={`Select all - ${stagedPlan.candidates.length}`}
              disabled={saving}
              onPress={selectAllCandidates}
            />
            <Button
              kind="secondary"
              label="Deselect all"
              disabled={saving}
              onPress={deselectAllCandidates}
            />
            {stagedPlan.identicalCount > 0 ? (
              <Button
                kind="secondary"
                label={`Select new & updates only - ${stagedPlan.newCount + stagedPlan.updateCount}`}
                disabled={saving}
                onPress={selectNewAndUpdatesOnly}
              />
            ) : null}
          </View>

          {/* Candidate Search */}
          <Field
            label="Search candidates"
            value={candidateFilter}
            onChangeText={setCandidateFilter}
          />

          {/* Candidates List Preview (Windowed to 25 items for smooth rendering) */}
          <View style={{ marginTop: 8 }}>
            {filteredCandidates.slice(0, 25).map((cand) => {
              const isSelected = selectedIds.has(cand.contact.id);
              return (
                <Pressable
                  key={cand.contact.id}
                  onPress={() => toggleCandidate(cand.contact.id)}
                  style={{
                    paddingVertical: 8,
                    borderTopWidth: 1,
                    borderTopColor: c.border,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <Text style={{ color: isSelected ? c.primary : c.sub, fontSize: 18, fontWeight: '700' }}>
                    {isSelected ? '☑' : '☐'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Text style={{ color: c.text, fontWeight: '600', fontSize: 15, flexShrink: 1 }}>
                        {cand.contact.fullName || 'No name'}
                      </Text>
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: '700',
                          paddingHorizontal: 5,
                          paddingVertical: 1,
                          borderRadius: 4,
                          backgroundColor:
                            cand.status === 'new'
                              ? c.success + '22'
                              : cand.status === 'update'
                              ? c.warn + '22'
                              : cand.status === 'conflict'
                              ? c.danger + '22'
                              : c.sub + '22',
                          color:
                            cand.status === 'new'
                              ? c.success
                              : cand.status === 'update'
                              ? c.warn
                              : cand.status === 'conflict'
                              ? c.danger
                              : c.sub,
                        }}
                      >
                        {cand.status.toUpperCase()}
                      </Text>
                    </View>
                    {cand.conflictReason ? (
                      <Text style={{ color: c.danger, fontSize: 12 }}>
                        ⚠️ {cand.conflictReason}
                      </Text>
                    ) : null}
                    {cand.changes?.length ? (
                      <Text style={{ color: c.warn, fontSize: 12 }}>
                        Changes: {cand.changes.join(', ')}
                      </Text>
                    ) : null}
                    {cand.contact.phones.map((phone, i) => (
                      <Text key={i} style={{ color: c.sub, fontSize: 13 }}>
                        {phone}
                      </Text>
                    ))}
                  </View>
                </Pressable>
              );
            })}
            {filteredCandidates.length > 25 ? (
              <Text style={{ color: c.sub, fontSize: 13, marginTop: 6 }}>
                Showing first 25 of {filteredCandidates.length} matches. Search to refine.
              </Text>
            ) : null}
          </View>

          {/* Staging Footer Actions */}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Button
              label={saving ? 'Saving…' : `Import ${selectedIds.size} selected`}
              disabled={selectedIds.size === 0 || saving}
              style={{ flex: 2 }}
              onPress={() => {
                void applyStagedImport();
              }}
            />
            <Button
              kind="secondary"
              label="Cancel review"
              disabled={saving}
              style={{ flex: 1 }}
              onPress={() => {
                setStagedPlan(null);
                setRawFetched(null);
                setSelectedIds(new Set());
                setCandidateFilter('');
                setMessage({
                  tone: 'info',
                  text: 'Import review cancelled. Existing cached contacts were preserved.',
                });
              }}
            />
          </View>
        </Card>
      ) : null}

      {/* 3. Shared Cached Contacts Viewer (Visible on BOTH Web and Native) */}
      <Card>
        <Text style={{ color: c.text, fontWeight: '700', fontSize: 15, marginBottom: 4 }}>
          {contacts.length} cached contacts
        </Text>
        {contacts.length > 0 ? (
          <>
            <Field
              label="Search cached contacts"
              value={search}
              onChangeText={setSearch}
            />
            {searchSummary.emptySearch ? (
              <Text style={{ color: c.sub, marginTop: 8, fontSize: 13 }}>
                {searchSummary.noticeText}
              </Text>
            ) : null}
            {visible.map((contact) => (
              <View
                key={contact.id}
                style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border }}
              >
                <Text style={{ color: c.text, fontWeight: '600', flexShrink: 1 }}>
                  {contact.fullName || 'No name'}
                </Text>
                {contact.phones.map((phone, index) => (
                  <Text key={`${contact.id}-phone-${index}`} style={{ color: c.sub, fontSize: 13 }}>
                    {phone}
                  </Text>
                ))}
                {contact.emails.map((email, index) => (
                  <Text key={`${contact.id}-email-${index}`} style={{ color: c.sub, fontSize: 13 }}>
                    {email}
                  </Text>
                ))}
              </View>
            ))}
            {searchSummary.truncated ? (
              <Text style={{ color: c.sub, marginTop: 6, fontSize: 13 }}>
                {searchSummary.noticeText}
              </Text>
            ) : null}
            <View style={{ marginTop: 12 }}>
              <ConfirmButton
                label="Clear Personal Assistant cached contacts"
                confirmLabel="Tap again to clear cache"
                onConfirm={async () => {
                  const error = await app.clearSyncedContacts();
                  setMessage(
                    error
                      ? { tone: 'danger', text: `Could not clear cached contacts: ${error}` }
                      : {
                          tone: 'info',
                          text: "Personal Assistant's local contact cache was cleared. Phone contacts were not changed.",
                        },
                  );
                }}
              />
            </View>
          </>
        ) : (
          <Text style={[typography.body, { color: c.sub, marginTop: 4 }]}>
            {Platform.OS === 'web'
              ? 'There are no cached contacts here. Restore a backup that contains contacts to view and search them.'
              : 'No contacts are cached. Tap "Refresh contacts now" above to import contacts from this phone.'}
          </Text>
        )}
      </Card>
    </ExpandableSection>
  );
}

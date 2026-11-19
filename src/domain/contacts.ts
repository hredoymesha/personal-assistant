import type { SyncedContact } from './types';

export type ContactCandidateStatus = 'new' | 'update' | 'identical' | 'conflict';

export interface ContactCandidate {
  contact: SyncedContact;
  status: ContactCandidateStatus;
  matchingExistingId?: string;
  changes?: string[];
  conflictReason?: string;
}

export interface StagingPlan {
  candidates: ContactCandidate[];
  newCount: number;
  updateCount: number;
  identicalCount: number;
  conflictCount: number;
}

/** Strips whitespace only. Country codes and digits are left alone. */
export function cleanPhone(phone: string): string {
  return phone.trim();
}

function areFieldsEqual(a: SyncedContact, b: SyncedContact): boolean {
  if (a.fullName.trim() !== b.fullName.trim()) return false;
  if ((a.photoUri ?? null) !== (b.photoUri ?? null)) return false;

  const aPhones = a.phones.map(cleanPhone).filter(Boolean).sort();
  const bPhones = b.phones.map(cleanPhone).filter(Boolean).sort();
  if (aPhones.length !== bPhones.length) return false;
  for (let i = 0; i < aPhones.length; i++) {
    if (aPhones[i] !== bPhones[i]) return false;
  }

  const aEmails = a.emails.map((e) => e.trim().toLowerCase()).filter(Boolean).sort();
  const bEmails = b.emails.map((e) => e.trim().toLowerCase()).filter(Boolean).sort();
  if (aEmails.length !== bEmails.length) return false;
  for (let i = 0; i < aEmails.length; i++) {
    if (aEmails[i] !== bEmails[i]) return false;
  }

  return true;
}

/**
 * Compares device contacts with the cached ones and decides what importing each would do.
 *
 * An existing record is only updated when it's clearly the same person: same ID, same name
 * and at least one phone number in common, or (across devices) the same name and the same set
 * of phones. A matching name alone is never enough, and two different names sharing one number
 * (a family or office line) is a conflict, not an overwrite. Anything else is new. Conflicts are
 * shown to the user and change nothing.
 */
export function planContactImport(
  existing: readonly SyncedContact[],
  incoming: readonly SyncedContact[],
): StagingPlan {
  const existingById = new Map<string, SyncedContact>();
  for (const c of existing) {
    existingById.set(c.id, c);
  }

  const candidates: ContactCandidate[] = [];
  let newCount = 0;
  let updateCount = 0;
  let identicalCount = 0;
  let conflictCount = 0;

  for (const inc of incoming) {
    const matchById = existingById.get(inc.id);

    if (matchById) {
      if (areFieldsEqual(matchById, inc)) {
        candidates.push({
          contact: inc,
          status: 'identical',
          matchingExistingId: matchById.id,
        });
        identicalCount++;
        continue;
      }

      // Fields are not identical. Enforce strict identity rules.
      const sameName =
        matchById.fullName.trim().toLowerCase() === inc.fullName.trim().toLowerCase();

      const incPhones = inc.phones.map(cleanPhone).filter(Boolean);
      const matchPhones = matchById.phones.map(cleanPhone).filter(Boolean);
      const sharedPhoneCount = incPhones.filter((p) => matchPhones.includes(p)).length;
      const hasSharedPhone = sharedPhoneCount > 0;

      // Guard 1: Name-only match with disjoint phones or empty phones
      if (sameName && !hasSharedPhone) {
        candidates.push({
          contact: inc,
          status: 'conflict',
          matchingExistingId: matchById.id,
          conflictReason: `Ambiguous identity: Same ID and name "${matchById.fullName}", but phone numbers do not match. Cannot safely overwrite.`,
        });
        conflictCount++;
        continue;
      }

      // Guard 2: Different name (ID collision or shared phone)
      if (!sameName) {
        candidates.push({
          contact: inc,
          status: 'conflict',
          matchingExistingId: matchById.id,
          conflictReason: `Name collision: ID matches existing contact "${matchById.fullName}". Cannot overwrite different person.`,
        });
        conflictCount++;
        continue;
      }

      // Verified Update: sameName is TRUE AND hasSharedPhone is TRUE
      const changes: string[] = [];
      if (JSON.stringify(matchById.phones) !== JSON.stringify(inc.phones)) changes.push('phones');
      if (JSON.stringify(matchById.emails) !== JSON.stringify(inc.emails)) changes.push('emails');
      if ((matchById.photoUri ?? null) !== (inc.photoUri ?? null)) changes.push('photo');

      candidates.push({
        contact: inc,
        status: 'update',
        matchingExistingId: matchById.id,
        changes,
      });
      updateCount++;
    } else {
      // No ID match. Check for cross-device match by content:
      // Requires BOTH identical full name AND identical non-empty phone set
      let contentMatch: SyncedContact | undefined;
      if (inc.fullName.trim() && inc.phones.length > 0) {
        const incPhones = inc.phones.map(cleanPhone).filter(Boolean).sort().join(',');
        for (const ex of existing) {
          if (ex.fullName.trim().toLowerCase() === inc.fullName.trim().toLowerCase()) {
            const exPhones = ex.phones.map(cleanPhone).filter(Boolean).sort().join(',');
            if (incPhones === exPhones) {
              contentMatch = ex;
              break;
            }
          }
        }
      }

      if (contentMatch) {
        if (areFieldsEqual(contentMatch, inc)) {
          candidates.push({
            contact: inc,
            status: 'identical',
            matchingExistingId: contentMatch.id,
          });
          identicalCount++;
        } else {
          const changes: string[] = [];
          if (JSON.stringify(contentMatch.emails) !== JSON.stringify(inc.emails)) changes.push('emails');
          if ((contentMatch.photoUri ?? null) !== (inc.photoUri ?? null)) changes.push('photo');

          candidates.push({
            contact: inc,
            status: 'update',
            matchingExistingId: contentMatch.id,
            changes,
          });
          updateCount++;
        }
      } else {
        // Completely new contact (including same name with different or empty phones)
        candidates.push({
          contact: inc,
          status: 'new',
        });
        newCount++;
      }
    }
  }

  return {
    candidates,
    newCount,
    updateCount,
    identicalCount,
    conflictCount,
  };
}

/**
 * Applies the selected rows of a plan. New rows are appended, updates replace only their
 * matching record, and conflicts and identical rows change nothing. Contacts that weren't
 * selected, or are no longer on the device, are kept.
 */
export function mergeSelectedContacts(
  existing: readonly SyncedContact[],
  selectedCandidates: readonly ContactCandidate[],
): {
  merged: SyncedContact[];
  addedCount: number;
  updatedCount: number;
  skippedConflictCount: number;
} {
  const map = new Map<string, SyncedContact>();
  for (const c of existing) {
    map.set(c.id, c);
  }

  let addedCount = 0;
  let updatedCount = 0;
  let skippedConflictCount = 0;

  for (const cand of selectedCandidates) {
    if (cand.status === 'conflict') {
      // A conflict never overwrites the existing contact
      skippedConflictCount++;
      continue;
    }

    if (cand.status === 'new') {
      map.set(cand.contact.id, cand.contact);
      addedCount++;
    } else if (cand.status === 'update') {
      const targetId = cand.matchingExistingId ?? cand.contact.id;
      const prev = map.get(targetId);
      if (prev) {
        map.set(targetId, {
          ...cand.contact,
          id: targetId,
        });
        updatedCount++;
      }
    } else if (cand.status === 'identical') {
      // Kept as-is
    }
  }

  const merged = Array.from(map.values()).sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );

  return { merged, addedCount, updatedCount, skippedConflictCount };
}

export function filterContacts(
  contacts: readonly SyncedContact[],
  query: string,
): SyncedContact[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...contacts];
  return contacts.filter((c) =>
    `${c.fullName} ${c.phones.join(' ')} ${c.emails.join(' ')}`.toLocaleLowerCase().includes(q),
  );
}

export const CACHED_CONTACTS_DISPLAY_LIMIT = 20;

export interface CachedContactsViewSummary {
  totalCachedCount: number;
  totalMatchedCount: number;
  displayedCount: number;
  isSearching: boolean;
  emptySearch: boolean;
  truncated: boolean;
  noticeText: string | null;
}

/** Counts for the cached-contacts list: all cached, matching the search, and shown on this page. */
export function summarizeCachedContactsView(
  totalCached: number,
  totalMatched: number,
  displayed: number,
  rawQuery: string,
  limit: number = CACHED_CONTACTS_DISPLAY_LIMIT,
): CachedContactsViewSummary {
  const isSearching = rawQuery.trim().length > 0;
  const emptySearch = isSearching && totalMatched === 0;
  const truncated = totalMatched > limit;

  let noticeText: string | null = null;
  if (emptySearch) {
    noticeText = 'No contacts match your search.';
  } else if (truncated) {
    if (isSearching) {
      noticeText = `Showing ${displayed} of ${totalMatched} matches. Refine search to find others.`;
    } else {
      noticeText = `Showing first ${displayed} of ${totalCached} cached contacts. Refine search to find others.`;
    }
  }

  return {
    totalCachedCount: totalCached,
    totalMatchedCount: totalMatched,
    displayedCount: displayed,
    isSearching,
    emptySearch,
    truncated,
    noticeText,
  };
}

/** True if the plan changed between preview and apply, compared row by row rather than by totals. */
export function hasPlanDrifted(
  stagedPlan: StagingPlan,
  freshPlan: StagingPlan,
): boolean {
  if (stagedPlan.candidates.length !== freshPlan.candidates.length) return true;
  if (
    stagedPlan.newCount !== freshPlan.newCount ||
    stagedPlan.updateCount !== freshPlan.updateCount ||
    stagedPlan.identicalCount !== freshPlan.identicalCount ||
    stagedPlan.conflictCount !== freshPlan.conflictCount
  ) {
    return true;
  }

  const freshMap = new Map<string, ContactCandidate>();
  for (const c of freshPlan.candidates) {
    freshMap.set(c.contact.id, c);
  }

  for (const s of stagedPlan.candidates) {
    const f = freshMap.get(s.contact.id);
    if (!f) return true;
    if (s.status !== f.status) return true;
    if (s.matchingExistingId !== f.matchingExistingId) return true;
    if ((s.conflictReason ?? '') !== (f.conflictReason ?? '')) return true;

    const sChanges = s.changes ?? [];
    const fChanges = f.changes ?? [];
    if (sChanges.length !== fChanges.length) return true;
    for (let j = 0; j < sChanges.length; j++) {
      if (sChanges[j] !== fChanges[j]) return true;
    }
  }

  return false;
}

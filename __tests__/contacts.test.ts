import {
  CACHED_CONTACTS_DISPLAY_LIMIT,
  cleanPhone,
  filterContacts,
  hasPlanDrifted,
  mergeSelectedContacts,
  planContactImport,
  summarizeCachedContactsView,
} from '../src/domain/contacts';
import type { SyncedContact } from '../src/domain/types';

describe('Contacts domain logic (Phase 1 Identity Safety & Revalidation)', () => {
  const existing: SyncedContact[] = [
    {
      id: 'c1',
      fullName: 'Anisur Rahman',
      phones: ['+8801700000001'],
      emails: ['anis@example.com'],
      photoUri: null,
      syncedAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: 'c2',
      fullName: 'Barkat Ullah',
      phones: ['+8801700000002'],
      emails: [],
      photoUri: 'file:///photo2.jpg',
      syncedAt: '2026-11-01T00:00:00.000Z',
    },
  ];

  // 1. Same ID, same name, completely different phones/emails
  it('flags same ID and same name with completely different phones as CONFLICT (name-only cannot authorize update)', () => {
    const incomingSameNameDiffPhone: SyncedContact[] = [
      {
        id: 'c1', // Same ID as Anisur Rahman
        fullName: 'Anisur Rahman', // Same name
        phones: ['+8801999999999'], // Completely different phone number
        emails: ['different@example.com'],
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    const plan = planContactImport(existing, incomingSameNameDiffPhone);
    expect(plan.conflictCount).toBe(1);
    expect(plan.updateCount).toBe(0);
    expect(plan.candidates[0].status).toBe('conflict');
    expect(plan.candidates[0].conflictReason).toContain('Ambiguous identity');

    // Merge must block it and preserve the original record
    const { merged, skippedConflictCount, updatedCount } = mergeSelectedContacts(
      existing,
      plan.candidates,
    );
    expect(skippedConflictCount).toBe(1);
    expect(updatedCount).toBe(0);
    const preserved = merged.find((c) => c.id === 'c1');
    expect(preserved?.phones).toEqual(['+8801700000001']);
  });

  // 2. Same ID, same name, both empty phone lists, different emails
  it('flags same ID and same name with empty phone lists and different emails as CONFLICT (cannot prove identity)', () => {
    const existingEmptyPhone: SyncedContact[] = [
      {
        id: 'ep1',
        fullName: 'Zahir Raihan',
        phones: [],
        emails: ['zahir@work.com'],
        photoUri: null,
        syncedAt: '2026-11-01T00:00:00.000Z',
      },
    ];

    const incomingEmptyPhoneDiffEmail: SyncedContact[] = [
      {
        id: 'ep1',
        fullName: 'Zahir Raihan',
        phones: [],
        emails: ['zahir@personal.com'],
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    const plan = planContactImport(existingEmptyPhone, incomingEmptyPhoneDiffEmail);
    expect(plan.conflictCount).toBe(1);
    expect(plan.updateCount).toBe(0);
    expect(plan.candidates[0].status).toBe('conflict');
  });

  // 3. Same ID, different identities sharing one phone number
  it('flags same ID with different names sharing a phone number as CONFLICT (shared number cannot authorize overwrite)', () => {
    const incomingSharedNumberDiffName: SyncedContact[] = [
      {
        id: 'c1', // Matches existing Anisur Rahman ID
        fullName: 'Chowdhury Kamal', // Different name
        phones: ['+8801700000001', '+8801800000099'], // Shares office/family phone +8801700000001
        emails: ['kamal@example.com'],
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    const plan = planContactImport(existing, incomingSharedNumberDiffName);
    expect(plan.conflictCount).toBe(1);
    expect(plan.updateCount).toBe(0);
    expect(plan.candidates[0].status).toBe('conflict');
    expect(plan.candidates[0].conflictReason).toContain('Name collision');

    const { merged, skippedConflictCount } = mergeSelectedContacts(existing, plan.candidates);
    expect(skippedConflictCount).toBe(1);
    const preserved = merged.find((c) => c.id === 'c1');
    expect(preserved?.fullName).toBe('Anisur Rahman');
  });

  // 4. Same ID, same name, and shared phone number (authorized legitimate update)
  it('authorizes update when same ID has matching full name AND shared phone continuity', () => {
    const incomingLegitUpdate: SyncedContact[] = [
      {
        id: 'c1',
        fullName: 'Anisur Rahman', // Same name
        phones: ['+8801700000001', '+8801700000099'], // Shares existing phone + adds new phone
        emails: ['anis.updated@example.com'], // Updated email
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    const plan = planContactImport(existing, incomingLegitUpdate);
    expect(plan.conflictCount).toBe(0);
    expect(plan.updateCount).toBe(1);
    expect(plan.candidates[0].status).toBe('update');
    expect(plan.candidates[0].changes).toContain('phones');
    expect(plan.candidates[0].changes).toContain('emails');

    const { merged, updatedCount } = mergeSelectedContacts(existing, plan.candidates);
    expect(updatedCount).toBe(1);
    const updated = merged.find((c) => c.id === 'c1');
    expect(updated?.emails).toEqual(['anis.updated@example.com']);
    expect(updated?.phones).toEqual(['+8801700000001', '+8801700000099']);
  });

  // 5. Apply-time revalidation: detects new conflict when cache drifts after preview
  it('apply-time revalidation detects conflict if cache changes between preview and apply', () => {
    const incomingCandidate: SyncedContact = {
      id: 'fresh-id',
      fullName: 'Tariqul Islam',
      phones: ['+8801555555555'],
      emails: [],
      photoUri: null,
      syncedAt: '2026-11-10T00:00:00.000Z',
    };

    // Staged preview against initial empty cache
    const initialCache: SyncedContact[] = [];
    const previewPlan = planContactImport(initialCache, [incomingCandidate]);
    expect(previewPlan.newCount).toBe(1);
    expect(previewPlan.conflictCount).toBe(0);

    // Meanwhile, a background restore or sync populates the cache with a colliding ID
    const driftedCache: SyncedContact[] = [
      {
        id: 'fresh-id', // Colliding ID!
        fullName: 'Different Person',
        phones: ['+8801777777777'],
        emails: [],
        photoUri: null,
        syncedAt: '2026-11-10T00:01:00.000Z',
      },
    ];

    // Revalidation against driftedCache detects the conflict!
    const revalidatedPlan = planContactImport(driftedCache, [incomingCandidate]);
    expect(revalidatedPlan.conflictCount).toBe(1);
    expect(revalidatedPlan.newCount).toBe(0);
    expect(revalidatedPlan.candidates[0].status).toBe('conflict');

    // Conflicting candidate is rejected from mutating the drifted cache
    const { merged, skippedConflictCount } = mergeSelectedContacts(
      driftedCache,
      revalidatedPlan.candidates,
    );
    expect(skippedConflictCount).toBe(1);
    expect(merged.length).toBe(1);
    expect(merged[0].fullName).toBe('Different Person');
  });

  // 6. Identical re-import produces zero additions, zero updates, zero conflicts
  it('re-importing exact identical contacts produces zero additions, zero updates, and zero conflicts', () => {
    const identicalIncoming: SyncedContact[] = [
      {
        id: 'c1',
        fullName: 'Anisur Rahman',
        phones: ['+8801700000001'],
        emails: ['anis@example.com'],
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
      {
        id: 'c2',
        fullName: 'Barkat Ullah',
        phones: ['+8801700000002'],
        emails: [],
        photoUri: 'file:///photo2.jpg',
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    const plan = planContactImport(existing, identicalIncoming);
    expect(plan.identicalCount).toBe(2);
    expect(plan.newCount).toBe(0);
    expect(plan.updateCount).toBe(0);
    expect(plan.conflictCount).toBe(0);

    const { merged, addedCount, updatedCount, skippedConflictCount } = mergeSelectedContacts(
      existing,
      plan.candidates,
    );
    expect(addedCount).toBe(0);
    expect(updatedCount).toBe(0);
    expect(skippedConflictCount).toBe(0);
    expect(merged.length).toBe(2);
  });

  // 7. Unselected or blocked candidate leaves existing record completely untouched
  it('unselected or blocked candidate leaves existing records completely untouched', () => {
    const incomingUpdate: SyncedContact[] = [
      {
        id: 'c1',
        fullName: 'Anisur Rahman',
        phones: ['+8801700000001', '+8801700000099'],
        emails: ['anis@example.com'],
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    const plan = planContactImport(existing, incomingUpdate);
    expect(plan.updateCount).toBe(1);

    // User chooses not to select the update
    const { merged, updatedCount } = mergeSelectedContacts(existing, []);
    expect(updatedCount).toBe(0);
    expect(merged.length).toBe(2);

    const c1 = merged.find((c) => c.id === 'c1');
    expect(c1?.phones).toEqual(['+8801700000001']);
  });

  // 8. Unrelated existing records preserved on new contact addition
  it('merging newly added contact preserves all unrelated existing records', () => {
    const incomingNew: SyncedContact[] = [
      {
        id: 'c99',
        fullName: 'Zubair Hossain',
        phones: ['+8801600000099'],
        emails: [],
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    const plan = planContactImport(existing, incomingNew);
    const { merged, addedCount } = mergeSelectedContacts(existing, plan.candidates);

    expect(addedCount).toBe(1);
    expect(merged.length).toBe(3);
    expect(merged.find((c) => c.id === 'c1')).toBeDefined();
    expect(merged.find((c) => c.id === 'c2')).toBeDefined();
    expect(merged.find((c) => c.id === 'c99')).toBeDefined();
  });

  // 9. Cross-device match requires both identical name and identical sorted phone set
  it('cross-device match requires both identical name and identical sorted phone set', () => {
    const crossDeviceMatch: SyncedContact[] = [
      {
        id: 'new-device-guid', // Different ID from another phone
        fullName: 'Barkat Ullah', // Same name
        phones: ['+8801700000002'], // Exact same phone
        emails: ['barkat.new@example.com'],
        photoUri: 'file:///photo2.jpg',
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    const plan = planContactImport(existing, crossDeviceMatch);
    expect(plan.updateCount).toBe(1);
    expect(plan.candidates[0].matchingExistingId).toBe('c2');
  });

  // 10. Filters contacts by query
  it('filters contacts by name, phone, or email case-insensitively', () => {
    expect(filterContacts(existing, 'anis').length).toBe(1);
    expect(filterContacts(existing, 'ANIS').length).toBe(1);
    expect(filterContacts(existing, '0000002').length).toBe(1);
    expect(filterContacts(existing, 'example.com').length).toBe(1);
    expect(filterContacts(existing, 'nonexistent').length).toBe(0);
    expect(filterContacts(existing, '').length).toBe(2);
  });

  // 11. cleanPhone normalization
  it('cleanPhone trims string without modifying digits', () => {
    expect(cleanPhone('  +880 1711-000000  ')).toBe('+880 1711-000000');
  });

  // 12. Count-preserving drift detection (target record or proposed values changed while counts stay equal)
  it('hasPlanDrifted detects semantic drift even when new/update/conflict counts remain identical', () => {
    const candidateA: SyncedContact = {
      id: 'cA',
      fullName: 'Contact Alpha',
      phones: ['+8801700000001'],
      emails: ['alpha.incoming@example.com'],
      photoUri: null,
      syncedAt: '2026-11-10T00:00:00.000Z',
    };
    const candidateB: SyncedContact = {
      id: 'cB',
      fullName: 'Contact Beta',
      phones: ['+8801700000002'],
      emails: ['beta@example.com'],
      photoUri: null,
      syncedAt: '2026-11-10T00:00:00.000Z',
    };

    // Staging Plan 1 (Initial Cache): cA is UPDATE (different email), cB is IDENTICAL
    const cache1: SyncedContact[] = [
      { ...candidateA, emails: ['alpha.initial@example.com'] }, // cA differs -> update
      { ...candidateB }, // cB matches -> identical
    ];
    const plan1 = planContactImport(cache1, [candidateA, candidateB]);
    expect(plan1.updateCount).toBe(1);
    expect(plan1.identicalCount).toBe(1);
    expect(plan1.newCount).toBe(0);
    expect(plan1.conflictCount).toBe(0);

    // Staging Plan 2 (Drifted Cache): Now cA is IDENTICAL, but cB is UPDATE!
    const cache2: SyncedContact[] = [
      { ...candidateA }, // cA now matches -> identical
      { ...candidateB, emails: ['beta.initial@example.com'] }, // cB now differs -> update
    ];
    const plan2 = planContactImport(cache2, [candidateA, candidateB]);
    // Note: Aggregate counts are identical (1 update, 1 identical, 0 new, 0 conflict)
    expect(plan2.updateCount).toBe(1);
    expect(plan2.identicalCount).toBe(1);
    expect(plan2.newCount).toBe(0);
    expect(plan2.conflictCount).toBe(0);

    // However, the targets and proposed field updates have completely drifted!
    expect(hasPlanDrifted(plan1, plan2)).toBe(true);

    // Self-check: comparing plan1 with itself returns false (no drift)
    expect(hasPlanDrifted(plan1, plan1)).toBe(false);
  });
});

describe('Cached Contacts Search & Empty-State Summarizer (Pure Domain Behavior)', () => {
  const sampleContacts: SyncedContact[] = Array.from({ length: 60 }, (_, i) => ({
    id: `syn-${i + 1}`,
    fullName: `Synthetic Contact ${i + 1}`,
    phones: [`+88017000000${(i + 1).toString().padStart(2, '0')}`],
    emails: [`contact${i + 1}@example.com`],
    photoUri: null,
    syncedAt: '2026-11-10T00:00:00.000Z',
  }));

  // 1. Empty cache
  it('handles empty cache with zero matched and zero displayed', () => {
    const summary = summarizeCachedContactsView(0, 0, 0, '');
    expect(summary.totalCachedCount).toBe(0);
    expect(summary.totalMatchedCount).toBe(0);
    expect(summary.displayedCount).toBe(0);
    expect(summary.isSearching).toBe(false);
    expect(summary.emptySearch).toBe(false);
    expect(summary.truncated).toBe(false);
    expect(summary.noticeText).toBeNull();
  });

  // 2. One cached contact, zero search matches (Screenshot Image 8 scenario)
  it('reports "No contacts match your search." when search has zero matches on non-empty cache', () => {
    const contacts: SyncedContact[] = [
      {
        id: 'c-one',
        fullName: 'A Girl',
        phones: ['+8801700000001'],
        emails: [],
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];
    const query = 'A Gl';
    const matched = filterContacts(contacts, query);
    expect(matched.length).toBe(0);

    const summary = summarizeCachedContactsView(
      contacts.length,
      matched.length,
      matched.slice(0, CACHED_CONTACTS_DISPLAY_LIMIT).length,
      query,
    );

    expect(summary.totalCachedCount).toBe(1);
    expect(summary.totalMatchedCount).toBe(0);
    expect(summary.displayedCount).toBe(0);
    expect(summary.isSearching).toBe(true);
    expect(summary.emptySearch).toBe(true);
    expect(summary.truncated).toBe(false);
    // Regression: it used to say "Showing first 20 of 1"
    expect(summary.noticeText).toBe('No contacts match your search.');
  });

  // 3. Search matches below display limit (e.g. 5 matches)
  it('omits truncation notice when search matches are below display limit', () => {
    const query = 'Contact 1'; // matches 1, 10-19 -> 11 items
    const matched = filterContacts(sampleContacts, query);
    expect(matched.length).toBeLessThanOrEqual(CACHED_CONTACTS_DISPLAY_LIMIT);

    const displayed = matched.slice(0, CACHED_CONTACTS_DISPLAY_LIMIT);
    const summary = summarizeCachedContactsView(
      sampleContacts.length,
      matched.length,
      displayed.length,
      query,
    );

    expect(summary.isSearching).toBe(true);
    expect(summary.emptySearch).toBe(false);
    expect(summary.truncated).toBe(false);
    expect(summary.noticeText).toBeNull();
  });

  // 4. Search matches exactly equal to display limit (20 matches)
  it('omits truncation notice when search matches exactly equal display limit', () => {
    const summary = summarizeCachedContactsView(50, 20, 20, 'query');
    expect(summary.isSearching).toBe(true);
    expect(summary.emptySearch).toBe(false);
    expect(summary.truncated).toBe(false);
    expect(summary.noticeText).toBeNull();
  });

  // 5. Search matches above display limit (e.g. 60 matches, displayed 20)
  it('reports actual displayed vs matched count when search matches exceed display limit', () => {
    const summary = summarizeCachedContactsView(100, 60, 20, 'synthetic');
    expect(summary.isSearching).toBe(true);
    expect(summary.emptySearch).toBe(false);
    expect(summary.truncated).toBe(true);
    expect(summary.noticeText).toBe('Showing 20 of 60 matches. Refine search to find others.');
  });

  // 6. No-query total above limit (Screenshot Image 3 scenario: 617 contacts)
  it('reports total cached contacts truncation notice when unsearched collection exceeds display limit', () => {
    const totalCached = 617;
    const summary = summarizeCachedContactsView(totalCached, totalCached, 20, '');
    expect(summary.isSearching).toBe(false);
    expect(summary.emptySearch).toBe(false);
    expect(summary.truncated).toBe(true);
    expect(summary.noticeText).toBe('Showing first 20 of 617 cached contacts. Refine search to find others.');
  });

  // 7. Whitespace query & query reset
  it('treats whitespace query as unsearched and preserves full list on reset', () => {
    // Whitespace only
    const whitespaceMatched = filterContacts(sampleContacts, '   ');
    expect(whitespaceMatched.length).toBe(sampleContacts.length);

    const wsSummary = summarizeCachedContactsView(
      sampleContacts.length,
      whitespaceMatched.length,
      20,
      '   ',
    );
    expect(wsSummary.isSearching).toBe(false);
    expect(wsSummary.emptySearch).toBe(false);
    expect(wsSummary.truncated).toBe(true);
    expect(wsSummary.noticeText).toBe('Showing first 20 of 60 cached contacts. Refine search to find others.');

    // Query cleared to empty string
    const resetMatched = filterContacts(sampleContacts, '');
    expect(resetMatched.length).toBe(sampleContacts.length);
    const resetSummary = summarizeCachedContactsView(
      sampleContacts.length,
      resetMatched.length,
      20,
      '',
    );
    expect(resetSummary.isSearching).toBe(false);
    expect(resetSummary.noticeText).toBe('Showing first 20 of 60 cached contacts. Refine search to find others.');
  });

  // 8. Case-insensitive and multi-field matching
  it('matches contacts across fullName, phone, and email case-insensitively', () => {
    const contacts: SyncedContact[] = [
      {
        id: 'c-alpha',
        fullName: 'Tariqul Islam',
        phones: ['+8801811223344'],
        emails: ['tariq@work.org'],
        photoUri: null,
        syncedAt: '2026-11-10T00:00:00.000Z',
      },
    ];

    expect(filterContacts(contacts, 'TARIQUL').length).toBe(1);
    expect(filterContacts(contacts, '181122').length).toBe(1);
    expect(filterContacts(contacts, 'work.org').length).toBe(1);
    expect(filterContacts(contacts, 'nonexistent').length).toBe(0);
  });
});

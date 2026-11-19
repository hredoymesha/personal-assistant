import { CycleBill, computeBillMonthState } from '../src/domain/cycle';

// The DUE badge used to start a day early east of UTC (Bangladesh, UTC+6) because the
// window was worked out through Date and toISOString. It must be the same everywhere.
const bill: CycleBill = {
  id: 'bill-1',
  userId: 'user-1',
  name: 'Internet',
  group: 'Utilities',
  expectedAmountMinor: 100000,
  currency: 'BDT',
  dueDay: 10,
  payee: 'ISP',
  isVariable: false,
  isPaused: false,
  autopay: false,
  completedInstallments: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const statusOn = (today: string) => computeBillMonthState(bill, '2026-11', [], null, today as never).status;

describe('bill due window', () => {
  const savedTz = process.env.TZ;
  afterAll(() => { process.env.TZ = savedTz; });

  for (const tz of ['UTC', 'Asia/Dhaka', 'America/New_York', 'Pacific/Auckland']) {
    it(`starts exactly three days before the due date in ${tz}`, () => {
      process.env.TZ = tz;
      expect(statusOn('2026-11-06')).toBe('upcoming');
      expect(statusOn('2026-11-07')).toBe('due');
      expect(statusOn('2026-11-10')).toBe('due');
      expect(statusOn('2026-11-11')).toBe('overdue');
    });
  }
});

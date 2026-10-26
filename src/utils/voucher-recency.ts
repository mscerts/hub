interface Voucher {
  data: {
    title: string;
    lastUpdated?: Date | boolean;
  };
}

export function compareVoucherRecency(left: Voucher, right: Voucher): number {
  const timestamp = (voucher: Voucher) =>
    voucher.data.lastUpdated instanceof Date
      ? voucher.data.lastUpdated.getTime()
      : 0;
  return (
    timestamp(right) - timestamp(left) ||
    left.data.title.localeCompare(right.data.title)
  );
}

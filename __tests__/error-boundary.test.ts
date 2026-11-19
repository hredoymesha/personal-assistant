import { ErrorBoundary } from '../src/ui/ErrorBoundary';

describe('RootLayout ErrorBoundary', () => {
  it('is exported as a function component', () => {
    expect(typeof ErrorBoundary).toBe('function');
  });

  it('returns a valid React element tree with error details and retry capability', () => {
    let retried = false;
    const testError = new Error('Test crash message');
    const element = ErrorBoundary({
      error: testError,
      retry: () => {
        retried = true;
      },
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
    expect(element.props).toBeDefined();

    // Verify children structure
    const card = element.props.children;
    expect(card).toBeDefined();
    expect(card.props).toBeDefined();

    // Verify the children within the card
    const cardChildren = card.props.children;
    expect(Array.isArray(cardChildren)).toBe(true);

    // cardChildren: [icon, title, subtitle, detailBox, retryButton]
    const titleNode = cardChildren.find(
      (child: any) => child?.props?.accessibilityRole === 'header'
    );
    expect(titleNode).toBeDefined();
    expect(titleNode.props.children).toBe('Something went wrong');

    // Find retry button
    const retryBtn = cardChildren.find(
      (child: any) => child?.props?.accessibilityRole === 'button'
    );
    expect(retryBtn).toBeDefined();
    expect(retryBtn.props.accessibilityLabel).toBe('Try again');

    // Trigger retry action
    retryBtn.props.onPress();
    expect(retried).toBe(true);
  });

  it('handles empty error message safely without throwing', () => {
    const emptyError = new Error('');
    const element = ErrorBoundary({
      error: emptyError,
      retry: () => {},
    });

    expect(element).toBeDefined();
    const card = element.props.children;
    const cardChildren = card.props.children;
    const detailBox = cardChildren.find(
      (child: any) => child?.props?.style?.backgroundColor === '#0F172A'
    );
    expect(detailBox).toBeDefined();
    const detailText = detailBox.props.children;
    expect(detailText.props.children).toBe('Unknown error');
  });
});

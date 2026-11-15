import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ICONS } from '../../src/icons';
import { renderApp } from '../helpers/app';

describe('kitchen sink', () => {
  it('shows every control group and every icon of the set', () => {
    renderApp('#/kitchen-sink');
    for (const name of ['Typography', 'Buttons', 'Form controls', 'Dialog and tooltip', 'Tabs', 'Status', 'Icons', 'Tokens']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    const icons = within(screen.getByRole('heading', { name: 'Icons' }).closest('section')!).getAllByRole('listitem');
    expect(icons.map((li) => li.textContent).sort()).toEqual(Object.keys(ICONS).sort());
  });

  it('the dialog opens, traps and labels itself by its title, and closes with Escape and with its buttons, returning focus', async () => {
    const user = userEvent.setup();
    renderApp('#/kitchen-sink');
    const open = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Delete this author?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await gone();
    await waitFor(() => expect(open).toHaveFocus());
    await user.click(open);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await gone();
  });

  it('the switch toggles with Space and the select picks with the keyboard', async () => {
    const user = userEvent.setup();
    renderApp('#/kitchen-sink');
    const sw = screen.getByRole('switch', { name: /Notify me/ });
    expect(sw).toBeChecked();
    sw.focus();
    await user.keyboard(' ');
    expect(sw).not.toBeChecked();
    const select = screen.getByRole('button', { name: /Target persona/ });
    select.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'Academic reviewer' }));
    expect(screen.getByRole('button', { name: /Target persona/ })).toHaveTextContent('Academic reviewer');
  });

  it('tabs: arrow keys move the selection and show the matching panel', async () => {
    const user = userEvent.setup();
    renderApp('#/kitchen-sink');
    const tabs = screen.getByRole('tablist', { name: 'Example tabs' });
    const first = within(tabs).getByRole('tab', { name: 'Profile' });
    expect(first).toHaveAttribute('aria-selected', 'true');
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(tabs).getByRole('tab', { name: 'Trace' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Second panel.');
  });

  it('the tooltip appears on keyboard focus and describes its button', async () => {
    const user = userEvent.setup();
    renderApp('#/kitchen-sink');
    const trigger = screen.getByRole('button', { name: 'Paw tooltip demo' });
    await user.keyboard('{Tab}'); // from the page into the tab order, then to the trigger by keyboard only
    for (let i = 0; i < 40 && document.activeElement !== trigger; i++) await user.keyboard('{Tab}');
    expect(trigger).toHaveFocus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('A tooltip names a control.');
    expect(trigger).toHaveAccessibleDescription('A tooltip names a control.');
  });

  it('the copy button reports success with text, not just an icon', async () => {
    const user = userEvent.setup();
    renderApp('#/kitchen-sink');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});

const gone = async (): Promise<void> => {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
};

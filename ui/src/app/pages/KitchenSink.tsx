import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Heading,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  TooltipTrigger,
} from 'react-aria-components';
import { ChevronIcon, ICONS, PawIcon } from '../../icons';
import type { IconName } from '../../icons';

const SWATCHES = ['bg', 'bg-raised', 'surface', 'border', 'accent', 'accent-2', 'danger', 'warning', 'success'] as const;
const PERSONAS = ['Plain-spoken journalist', 'Academic reviewer', 'Friendly newsletter'] as const;

/** Every control the app will use, in one place: this page is what the visual and accessibility tests look at. */
export function KitchenSink() {
  const [copied, setCopied] = useState(false);
  const [notify, setNotify] = useState(true);
  return (
    <section aria-labelledby="ks-h" className="gw-page">
      <h1 id="ks-h">Kitchen sink</h1>
      <p className="gw-lede">Every control and token in the current theme. Switch themes in the header to compare.</p>

      <div className="gw-grid">
        <section className="gw-card" aria-labelledby="ks-type">
          <h2 id="ks-type">Typography</h2>
          <p>
            Body text in the body font, with a <a href="#/kitchen-sink">link</a> and <code>inline code</code>. Secondary text is quieter.
          </p>
          <p className="gw-muted">Muted: the second line of a hint, or a caption.</p>
          <ul className="gw-paw-list">
            <li>First item</li>
            <li>Second item</li>
            <li>Third item</li>
          </ul>
        </section>

        <section className="gw-card" aria-labelledby="ks-btn">
          <h2 id="ks-btn">Buttons</h2>
          <div className="gw-row">
            <Button className="gw-btn gw-btn--primary">Primary</Button>
            <Button className="gw-btn">Secondary</Button>
            <Button className="gw-btn gw-btn--danger">Delete</Button>
            <Button className="gw-btn" isDisabled>
              Disabled
            </Button>
          </div>
          <div className="gw-row">
            <Button
              className="gw-btn"
              onPress={() => {
                setCopied(true);
              }}
            >
              {copied ? <ICONS.check size={16} /> : <ICONS.copy size={16} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button className="gw-btn gw-btn--primary">
              <ICONS.play size={16} />
              Run
            </Button>
          </div>
        </section>

        <section className="gw-card" aria-labelledby="ks-form">
          <h2 id="ks-form">Form controls</h2>
          <Select className="gw-select gw-select--block" defaultSelectedKey={PERSONAS[0]}>
            <Label className="gw-label">Target persona</Label>
            <Button className="gw-btn gw-select__button">
              <SelectValue />
              <ChevronIcon size={16} className="gw-select__chevron" />
            </Button>
            <Popover className="gw-popover">
              <ListBox className="gw-listbox">
                {PERSONAS.map((p) => (
                  <ListBoxItem key={p} id={p} className="gw-listbox__item">
                    {p}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>
          <Switch className="gw-switch" isSelected={notify} onChange={setNotify}>
            <span className="gw-switch__track" aria-hidden="true">
              <span className="gw-switch__thumb" />
            </span>
            Notify me when a run finishes
          </Switch>
        </section>

        <section className="gw-card" aria-labelledby="ks-overlay">
          <h2 id="ks-overlay">Dialog and tooltip</h2>
          <div className="gw-row">
            <DialogTrigger>
              <Button className="gw-btn">Open dialog</Button>
              <ModalOverlay className="gw-overlay" isDismissable>
                <Modal className="gw-modal">
                  <Dialog className="gw-dialog">
                    {({ close }) => (
                      <>
                        <Heading slot="title" className="gw-dialog__title">
                          Delete this author?
                        </Heading>
                        <p>Their stored profile is removed from this machine. The original text is not touched.</p>
                        <div className="gw-row">
                          <Button className="gw-btn" onPress={close}>
                            Cancel
                          </Button>
                          <Button className="gw-btn gw-btn--danger" onPress={close}>
                            Delete
                          </Button>
                        </div>
                      </>
                    )}
                  </Dialog>
                </Modal>
              </ModalOverlay>
            </DialogTrigger>
            <TooltipTrigger delay={0}>
              <Button className="gw-btn" aria-label="Paw tooltip demo">
                <PawIcon size={16} />
              </Button>
              <Tooltip className="gw-tooltip" offset={8}>
                A tooltip names a control.
              </Tooltip>
            </TooltipTrigger>
          </div>
        </section>

        <section className="gw-card" aria-labelledby="ks-tabs">
          <h2 id="ks-tabs">Tabs</h2>
          <Tabs className="gw-tabs">
            <TabList className="gw-tablist" aria-label="Example tabs">
              <Tab id="one" className="gw-tab">
                Profile
              </Tab>
              <Tab id="two" className="gw-tab">
                Trace
              </Tab>
              <Tab id="three" className="gw-tab">
                Settings
              </Tab>
            </TabList>
            <TabPanel id="one" className="gw-tabpanel">
              The active tab carries a vertical slit marker.
            </TabPanel>
            <TabPanel id="two" className="gw-tabpanel">
              Second panel.
            </TabPanel>
            <TabPanel id="three" className="gw-tabpanel">
              Third panel.
            </TabPanel>
          </Tabs>
        </section>

        <section className="gw-card" aria-labelledby="ks-status">
          <h2 id="ks-status">Status</h2>
          <p className="gw-status gw-status--success">
            <ICONS.check size={18} /> Saved
          </p>
          <p className="gw-status gw-status--warning">
            <ICONS.warning size={18} /> Heads up: this run calls the model
          </p>
          <p className="gw-status gw-status--danger">
            <ICONS.warning size={18} /> The model could not be reached
          </p>
        </section>

        <section className="gw-card" aria-labelledby="ks-icons">
          <h2 id="ks-icons">Icons</h2>
          <ul className="gw-icons">
            {(Object.keys(ICONS) as IconName[]).map((name) => {
              const Icon = ICONS[name];
              return (
                <li key={name}>
                  <Icon size={24} />
                  <span>{name}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="gw-card" aria-labelledby="ks-tokens">
          <h2 id="ks-tokens">Tokens</h2>
          <ul className="gw-swatches">
            {SWATCHES.map((s) => (
              <li key={s}>
                <span className={`gw-swatch gw-swatch--${s}`} aria-hidden="true" />
                <code>--gw-{s}</code>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}

import SiteHeader from './SiteHeader';

// App pages (quote builder, checkout, orders, admin) use the same header as
// the public site. Kept as a module so existing imports keep working.
export default function Header() {
  return <SiteHeader />;
}

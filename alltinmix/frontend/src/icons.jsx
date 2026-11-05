import React from 'react';
import {
  Bike, Briefcase, BriefcaseBusiness, Building2, Car, Clapperboard, Code, Download, House, Languages, Layers, Mountain, Package,
  Palette, PenLine, Sailboat, Shirt, ShoppingBag, ShoppingBasket, Smartphone, Sofa, Sparkles, Store, Tag, Truck, Wrench,
} from 'lucide-react';

/**
 * Icons that marketplace.config.js can refer to by name (`icon`, `categoryIcons`).
 * To use another lucide icon: import it above and add it here. Unknown names fall back to a tag icon.
 */
const REGISTRY = {
  Bike, Briefcase, BriefcaseBusiness, Building2, Car, Clapperboard, Code, Download, House, Languages, Layers, Mountain, Package,
  Palette, PenLine, Sailboat, Shirt, ShoppingBag, ShoppingBasket, Smartphone, Sofa, Sparkles, Store, Tag, Truck, Wrench,
};

export function Icon({ name, size = 18, ...rest }) {
  const Cmp = REGISTRY[name] || Tag;
  return <Cmp size={size} aria-hidden="true" {...rest} />;
}

/** Icon for a category, falling back to the icon of its vertical. */
export const categoryIconName = (vertical, category) => vertical?.categoryIcons?.[category] || vertical?.icon;

# 🛒 E-commerce Template

Pre-built e-commerce collections for LumiBase.

## 📦 What's Included

### Collections

1. **Products**
   - Full product information (name, description, price)
   - Inventory tracking (SKU, quantity, barcode)
   - Pricing (price, compare_at_price, cost_per_item)
   - Status management (draft, active, archived)
   - Featured products support
   - Weight and dimensions

2. **Categories**
   - Hierarchical categories (parent/child)
   - SEO-friendly slugs
   - Sort order support

3. **Product Categories** (Junction)
   - Many-to-many relationship
   - Products can belong to multiple categories

4. **Product Images**
   - Multiple images per product
   - Primary image designation
   - Sort order support
   - Alt text for accessibility

5. **Orders**
   - Complete order management
   - Order status tracking (pending, processing, shipped, delivered, cancelled, refunded)
   - Payment status tracking
   - Shipping and billing addresses
   - Order notes (customer and admin)
   - Tracking information

6. **Order Items**
   - Line items for each order
   - Product snapshot (preserves data if product deleted)
   - Quantity and pricing

7. **Order Status History**
   - Audit log of status changes
   - Automatic logging via triggers

## 🚀 Installation

```bash
./scripts/add-template.sh ecommerce
```

This will:
1. Run database migrations
2. Create all tables with proper relationships
3. Set up Row Level Security policies
4. Create indexes for performance
5. Import Directus schema (if available)

## 📊 Database Schema

```
users (from base)
  ↓
products ← product_images
  ↓
product_categories → categories
  ↓
order_items → orders → order_status_history
```

## 🔐 Security (RLS Policies)

### Products
- ✅ Anyone can view active products
- ✅ Authenticated users can view all products
- ✅ Users can create products (assigned to them)
- ✅ Users can update own products
- ✅ Service role has full access

### Categories
- ✅ Anyone can view categories
- ✅ Authenticated users can manage categories

### Orders
- ✅ Users can view own orders
- ✅ Users can create own orders
- ✅ Users can update own pending orders
- ✅ Service role has full access

### Order Items
- ✅ Users can view items from own orders
- ✅ Users can create items for own orders
- ✅ Service role has full access

## 🎨 Directus Collections

After installation, you'll see these collections in Directus:

1. **Products** - Manage product catalog
2. **Categories** - Organize products
3. **Product Images** - Upload product photos
4. **Orders** - View and manage orders
5. **Order Items** - Order line items
6. **Order Status History** - Audit trail

## 📝 Usage Examples

### Create a Product

```typescript
const { data, error } = await supabase
  .from('products')
  .insert({
    name: 'Awesome T-Shirt',
    slug: 'awesome-t-shirt',
    description: 'The most awesome t-shirt ever',
    price: 29.99,
    sku: 'TSH-001',
    quantity: 100,
    status: 'active',
    created_by: user.uid
  });
```

### Get Products by Category

```typescript
const { data, error } = await supabase
  .from('products')
  .select(`
    *,
    product_categories!inner (
      categories (
        name,
        slug
      )
    )
  `)
  .eq('product_categories.categories.slug', 't-shirts')
  .eq('status', 'active');
```

### Create an Order

```typescript
// 1. Create order
const { data: order, error } = await supabase
  .from('orders')
  .insert({
    user_id: user.uid,
    subtotal: 59.98,
    tax: 5.40,
    shipping_cost: 10.00,
    total: 75.38,
    shipping_name: 'John Doe',
    shipping_email: 'john@example.com',
    // ... other shipping details
  })
  .select()
  .single();

// 2. Add order items
const { data: items, error: itemsError } = await supabase
  .from('order_items')
  .insert([
    {
      order_id: order.id,
      product_id: 'product-uuid-1',
      product_name: 'Awesome T-Shirt',
      quantity: 2,
      unit_price: 29.99,
      total_price: 59.98
    }
  ]);
```

### Update Order Status

```typescript
const { data, error } = await supabase
  .from('orders')
  .update({
    status: 'shipped',
    tracking_number: 'TRACK123456',
    shipped_at: new Date().toISOString()
  })
  .eq('id', orderId);

// Status change is automatically logged in order_status_history
```

## 🎯 Features

### Automatic Features

1. **Order Number Generation**
   - Format: `ORD-YYYYMMDD-XXXXXX`
   - Example: `ORD-20260304-000001`
   - Auto-increments daily

2. **Status Change Logging**
   - Automatic audit trail
   - Tracks all status changes
   - Includes timestamps

3. **Updated At Timestamps**
   - Auto-updates on record changes
   - Applies to products, categories, orders

4. **Product Snapshot in Orders**
   - Preserves product data even if product deleted
   - Ensures order history integrity

### Performance Optimizations

- Indexes on frequently queried columns
- Efficient foreign key relationships
- Optimized RLS policies

## 🔧 Customization

### Add Custom Fields

Edit migration files before running:

```sql
-- Add custom field to products
ALTER TABLE public.products
ADD COLUMN custom_field VARCHAR(255);
```

### Modify RLS Policies

```sql
-- Example: Allow public to create products
CREATE POLICY "Public can create products"
    ON public.products FOR INSERT
    WITH CHECK (true);
```

## 📚 Next Steps

1. **Customize in Directus**
   - Add custom fields via UI
   - Configure relationships
   - Set up display templates

2. **Add Payment Integration**
   - Stripe
   - PayPal
   - Other payment gateways

3. **Add Inventory Management**
   - Low stock alerts
   - Automatic reordering
   - Warehouse management

4. **Add Shipping Integration**
   - Shipping rate calculation
   - Label printing
   - Tracking updates

## 🐛 Troubleshooting

### Migration Fails

```bash
# Reset and try again
docker-compose down -v
docker-compose up -d
./scripts/migrate.sh
./scripts/add-template.sh ecommerce
```

### RLS Blocks Access

Check JWT token includes correct `firebase_uid`:

```typescript
const token = await user.getIdToken();
console.log(jwt.decode(token));
// Should include: { sub: "firebase_uid", ... }
```

## 📖 Resources

- [Supabase RLS Guide](https://supabase.com/docs/guides/auth/row-level-security)
- [PostgreSQL Triggers](https://www.postgresql.org/docs/current/trigger-definition.html)
- [Directus Relations](https://docs.directus.io/configuration/data-model/relationships.html)

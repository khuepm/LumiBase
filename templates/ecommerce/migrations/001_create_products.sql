-- E-commerce Template: Products Table
-- Creates products table with full e-commerce features

-- Create products table
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    short_description VARCHAR(500),
    price DECIMAL(10, 2) NOT NULL,
    compare_at_price DECIMAL(10, 2),
    cost_per_item DECIMAL(10, 2),
    sku VARCHAR(100) UNIQUE,
    barcode VARCHAR(100),
    quantity INTEGER DEFAULT 0,
    track_quantity BOOLEAN DEFAULT true,
    continue_selling_when_out_of_stock BOOLEAN DEFAULT false,
    weight DECIMAL(10, 2),
    weight_unit VARCHAR(10) DEFAULT 'kg',
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
    featured BOOLEAN DEFAULT false,
    created_by VARCHAR(128) REFERENCES public.users(firebase_uid),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create categories table
CREATE TABLE IF NOT EXISTS public.categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    parent_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create product_categories junction table
CREATE TABLE IF NOT EXISTS public.product_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(product_id, category_id)
);

-- Create product_images table
CREATE TABLE IF NOT EXISTS public.product_images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    alt_text VARCHAR(255),
    sort_order INTEGER DEFAULT 0,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_products_slug ON public.products(slug);
CREATE INDEX IF NOT EXISTS idx_products_status ON public.products(status);
CREATE INDEX IF NOT EXISTS idx_products_featured ON public.products(featured);
CREATE INDEX IF NOT EXISTS idx_products_created_by ON public.products(created_by);
CREATE INDEX IF NOT EXISTS idx_categories_slug ON public.categories(slug);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON public.categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_product_categories_product ON public.product_categories(product_id);
CREATE INDEX IF NOT EXISTS idx_product_categories_category ON public.product_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON public.product_images(product_id);

-- Create triggers for updated_at
CREATE TRIGGER update_products_updated_at
    BEFORE UPDATE ON public.products
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_categories_updated_at
    BEFORE UPDATE ON public.categories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;

-- RLS Policies for products
CREATE POLICY "Anyone can view active products"
    ON public.products FOR SELECT
    USING (status = 'active');

CREATE POLICY "Authenticated users can view all products"
    ON public.products FOR SELECT
    USING (auth.uid() IS NOT NULL);

CREATE POLICY "Users can create products"
    ON public.products FOR INSERT
    WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can update own products"
    ON public.products FOR UPDATE
    USING (auth.uid() = created_by)
    WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Service role has full access to products"
    ON public.products FOR ALL
    USING (auth.role() = 'service_role');

-- RLS Policies for categories
CREATE POLICY "Anyone can view categories"
    ON public.categories FOR SELECT
    USING (true);

CREATE POLICY "Authenticated users can manage categories"
    ON public.categories FOR ALL
    USING (auth.uid() IS NOT NULL);

-- RLS Policies for product_categories
CREATE POLICY "Anyone can view product categories"
    ON public.product_categories FOR SELECT
    USING (true);

CREATE POLICY "Authenticated users can manage product categories"
    ON public.product_categories FOR ALL
    USING (auth.uid() IS NOT NULL);

-- RLS Policies for product_images
CREATE POLICY "Anyone can view product images"
    ON public.product_images FOR SELECT
    USING (true);

CREATE POLICY "Authenticated users can manage product images"
    ON public.product_images FOR ALL
    USING (auth.uid() IS NOT NULL);

-- Add comments
COMMENT ON TABLE public.products IS 'E-commerce products with inventory tracking';
COMMENT ON TABLE public.categories IS 'Product categories with hierarchical support';
COMMENT ON TABLE public.product_categories IS 'Many-to-many relationship between products and categories';
COMMENT ON TABLE public.product_images IS 'Product images with sort order';

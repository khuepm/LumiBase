import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  createSponsor,
  generateRewardToken,
  getAllSponsors,
  removeSponsor,
} from '@/lib/rewards';

// GitHub webhook secret (set this in environment variables)
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

export async function POST(req: NextRequest) {
  try {
    // Get signature from headers
    const signature = req.headers.get('x-hub-signature-256');
    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    // Get raw body
    const rawBody = await req.text();

    // Verify GitHub signature
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    hmac.update(rawBody);
    const expectedSignature = `sha256=${hmac.digest('hex')}`;

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // Parse payload
    const payload = JSON.parse(rawBody);

    // Handle sponsorship events
    if (payload.action === 'created' || payload.action === 'edited') {
      const sponsorship = payload.sponsorship;
      const sponsor = sponsorship.sponsor.login;
      const tier = sponsorship.tier.monthly_price_in_cents || 0;

      // Generate unique reward token
      const rewardToken = generateRewardToken();

      // Persist through the shared sponsor store (D1 when bound, otherwise
      // process-local — see apps/landing/README.md).
      await createSponsor(sponsor, tier, rewardToken);

      console.log(`New sponsor: ${sponsor} at tier $${tier / 100}/mo`);

      // In production, you would also:
      // 1. Send the token to the sponsor via GitHub API or email
      // 2. Trigger a welcome email with reward instructions

      return NextResponse.json({
        success: true,
        message: 'Sponsorship recorded',
        sponsor,
        tier,
        rewardToken,
      });
    }

    if (payload.action === 'cancelled') {
      const sponsor = payload.sponsorship.sponsor.login;
      await removeSponsor(sponsor);
      console.log(`Sponsor cancelled: ${sponsor}`);

      return NextResponse.json({
        success: true,
        message: 'Sponsorship cancelled',
        sponsor,
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Event received',
      action: payload.action,
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET endpoint for testing (remove in production)
export async function GET() {
  const sponsors = await getAllSponsors();

  return NextResponse.json({
    message: 'GitHub Sponsors webhook endpoint',
    // Reward tokens are credentials — never list them.
    sponsors: sponsors.map((sponsor) => ({
      githubUser: sponsor.githubUser,
      tier: sponsor.tier,
      createdAt: sponsor.createdAt,
      claimed: sponsor.claimed,
      claimedAt: sponsor.claimedAt,
    })),
  });
}

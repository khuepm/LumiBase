import crypto from 'crypto';

// In-memory storage for demo purposes (replace with database in production)
const sponsors = new Map<string, {
  githubUser: string;
  tier: number;
  rewardToken: string;
  createdAt: Date;
  claimed: boolean;
  claimedAt?: Date;
}>();

export function generateRewardToken(githubUser: string, tier: number): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createSponsor(githubUser: string, tier: number, rewardToken: string) {
  sponsors.set(githubUser, {
    githubUser,
    tier,
    rewardToken,
    createdAt: new Date(),
    claimed: false,
  });
}

export function getSponsorByToken(token: string) {
  for (const [githubUser, sponsor] of sponsors.entries()) {
    if (sponsor.rewardToken === token) {
      return sponsor;
    }
  }
  return null;
}

export function getSponsorByGitHubUser(githubUser: string) {
  return sponsors.get(githubUser);
}

export function claimReward(token: string): { success: boolean; tier?: number; error?: string } {
  const sponsor = getSponsorByToken(token);
  
  if (!sponsor) {
    return { success: false, error: 'Invalid reward token' };
  }
  
  if (sponsor.claimed) {
    return { success: false, error: 'Reward already claimed' };
  }
  
  // Mark as claimed
  sponsor.claimed = true;
  sponsor.claimedAt = new Date();
  
  return { success: true, tier: sponsor.tier };
}

export function getAllSponsors() {
  return Array.from(sponsors.values());
}

// In production, replace these with database operations
export async function saveToDatabase(sponsor: {
  githubUser: string;
  tier: number;
  rewardToken: string;
}) {
  // TODO: Implement database save
  // Example with PostgreSQL:
  // await db.sponsors.create({
  //   data: {
  //     githubUser: sponsor.githubUser,
  //     tier: sponsor.tier,
  //     rewardToken: sponsor.rewardToken,
  //     createdAt: new Date(),
  //   }
  // });
}

export async function updateClaimStatus(token: string) {
  const sponsor = getSponsorByToken(token);
  if (sponsor) {
    sponsor.claimed = true;
    sponsor.claimedAt = new Date();
  }
}

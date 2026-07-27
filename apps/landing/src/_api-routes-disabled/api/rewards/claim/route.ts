import { NextRequest, NextResponse } from 'next/server';
import { claimReward } from '@/lib/rewards';

export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();
    
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Token is required' },
        { status: 400 }
      );
    }
    
    // Atomic in the store: two requests racing on the same token yield one
    // success and one "already claimed".
    const result = await claimReward(token);
    
    return NextResponse.json(result);
    
  } catch (error) {
    console.error('Claim reward error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

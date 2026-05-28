import { Handle, Position } from '@xyflow/react';
import {
  GitBranch,
  RefreshCw,
  Globe,
  Mail,
  Terminal,
  Clock,
  Puzzle,
  Database,
} from 'lucide-react';

// Common node wrapper with glassmorphism and smooth borders
function NodeWrapper({
  title,
  icon: Icon,
  colorClass,
  shapeClass = 'rounded-xl',
  children,
  selected,
}: {
  title: string;
  icon: any;
  colorClass: string;
  shapeClass?: string;
  children?: React.ReactNode;
  selected?: boolean;
}) {
  return (
    <div
      className={`min-w-[180px] border bg-background/90 p-3 shadow-md backdrop-blur-sm transition-all duration-200 ${shapeClass} ${
        selected ? 'ring-2 ring-primary border-primary/50 scale-[1.02]' : 'hover:border-primary/30'
      }`}
    >
      <div className="flex items-center gap-2 border-b pb-1.5 mb-2">
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg border ${colorClass}`}>
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-xs font-bold text-foreground tracking-wide uppercase">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function ConditionNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-primary" />
      
      {/* Diamond-like layout styling */}
      <NodeWrapper
        title="Condition"
        icon={GitBranch}
        colorClass="bg-amber-500/10 text-amber-500 border-amber-500/20"
        shapeClass="rounded-xl"
        selected={selected}
      >
        <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[150px]">
          {data.expression || 'if (data.status === "active")'}
        </div>
      </NodeWrapper>
      
      {/* Yes and No handles */}
      <Handle
        type="source"
        position={Position.Right}
        id="yes"
        className="w-2.5 h-2.5 bg-emerald-500 !top-1/3"
        style={{ right: -4 }}
      />
      <span className="absolute right-2 top-[12px] text-[8px] font-bold text-emerald-600">YES</span>
      
      <Handle
        type="source"
        position={Position.Right}
        id="no"
        className="w-2.5 h-2.5 bg-rose-500 !top-2/3"
        style={{ right: -4 }}
      />
      <span className="absolute right-2 top-[32px] text-[8px] font-bold text-rose-600">NO</span>
    </div>
  );
}

export function TransformNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-primary" />
      <NodeWrapper
        title="Transform"
        icon={RefreshCw}
        colorClass="bg-indigo-500/10 text-indigo-500 border-indigo-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[150px]">
          {data.script ? 'Custom JS Mapping' : 'No transform script'}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-primary" />
    </div>
  );
}

export function HttpNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-primary" />
      <NodeWrapper
        title="HTTP Request"
        icon={Globe}
        colorClass="bg-blue-500/10 text-blue-500 border-blue-500/20"
        selected={selected}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[9px] font-bold text-blue-600 uppercase font-mono">{data.method || 'GET'}</span>
          <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[150px]">
            {data.url || 'https://api.example.com'}
          </span>
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-primary" />
    </div>
  );
}

export function MailNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-primary" />
      <NodeWrapper
        title="Send Mail"
        icon={Mail}
        colorClass="bg-violet-500/10 text-violet-500 border-violet-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-muted-foreground truncate max-w-[150px]">
          {data.to || 'recipient@example.com'}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-primary" />
    </div>
  );
}

export function LogNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-primary" />
      <NodeWrapper
        title="Log Terminal"
        icon={Terminal}
        colorClass="bg-slate-500/10 text-slate-500 border-slate-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[150px]">
          {data.message || 'Log message...'}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-primary" />
    </div>
  );
}

export function SleepNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-primary" />
      <NodeWrapper
        title="Delay Sleep"
        icon={Clock}
        colorClass="bg-orange-500/10 text-orange-500 border-orange-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-muted-foreground">
          {data.duration ? `${data.duration} ms` : '1000 ms'}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-primary" />
    </div>
  );
}

export function RunExtensionNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-primary" />
      <NodeWrapper
        title="Run Extension"
        icon={Puzzle}
        colorClass="bg-rose-500/10 text-rose-500 border-rose-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-muted-foreground truncate max-w-[150px]">
          {data.extensionName || 'Select extension...'}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-primary" />
    </div>
  );
}

export function ItemCrudNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-primary" />
      <NodeWrapper
        title="Database CRUD"
        icon={Database}
        colorClass="bg-cyan-500/10 text-cyan-500 border-cyan-500/20"
        selected={selected}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[9px] font-bold text-cyan-600 uppercase font-mono">{data.action || 'item.create'}</span>
          <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[150px]">
            {data.collection || 'Select collection...'}
          </span>
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-primary" />
    </div>
  );
}

export const flowNodeTypes = {
  condition: ConditionNode,
  transform: TransformNode,
  http: HttpNode,
  mail: MailNode,
  log: LogNode,
  sleep: SleepNode,
  'run-extension': RunExtensionNode,
  'item-crud': ItemCrudNode,
};

# OOP method dispatch for binary `.m` class modules

Reverse-engineered 1-for-1 from real EC v3.3a output by instruction-tracing
under vamos (`vamos -I -C 68020`). The reference program imported `afc/parser`
(a binary class module) and ran `NEW p.parser()`, `p.version()`, `p.arg(s)`,
`END p`. Source of truth: the EC trace, cross-checked against the module's
v7+ OBJ trailer (`src/emod.js`) and EC's `WRITEMODULE` (`EC733_v33a.S:7255+`).

This is the model for the 66 method-only (class) modules. Source-defined
classes in ecomp use a *different*, static-dispatch model (self on the stack);
binary-module classes use the **runtime vtable** model below (self in A0).

## What the `.m` gives us (per class object, v7+ trailer)

    OSIZE   = objrec.size      instance byte size           (parser: 28 = $1c)
    delsize = descriptor bytes (vtable size)                 (parser: 24 = $18)
    delcode = code offset of the DESCRIPTOR-BUILDER inside the module's own code
                                                             (parser: 848 = $350)
    odestr  = vtable slot of the destructor method           (parser: 12 = $c)
    methods[] = { name, slot (M_OFF), args, kind }
                slots are 4,8,12,16,…  (NOT code offsets — code offsets are
                NOT in the module; only the builder knows them, via PC-rel LEA)

The constructor is the method whose name == the class name (parser → slot 20).

## The descriptor (vtable)

A per-class structure of `delsize` bytes, built by **calling the module's own
code at `delcode`** (the builder fills the region pointed to by A0). Because the
builder addresses each method with PC-relative `lea`, once the module code is
blobbed contiguously into our output **no relocations are needed** for it.

    descriptor[0]      = OSIZE                  (instance byte size)
    descriptor[slot]   = method code pointer    (slot = 4,8,12,16,20,…)

## Instance

    New(OSIZE)             allocate from the E memory pool (our __new ifunc)
    instance[0] = descriptor ptr
    instance[4..]          object members

## `NEW obj.class(args)`  (EC-generated wrapper, traced)

    lea     descr_region(A4), A0    ; A0 = &descriptor area in globals
    move.l  A0, descrptr_slot(A4)   ; remember the descriptor pointer
    jsr     builder@(modbase+delcode)   ; fills descriptor[0]=OSIZE, [slot]=method*
    move.l  #OSIZE, -(A7)
    bsr     __new                   ; New(OSIZE) -> D0 = instance
    addq.l  #4, A7
    move.l  D0, <target>            ; the PTR TO class variable
    movea.l D0, A0
    move.l  descrptr_slot(A4), (A0) ; instance[0] = descriptor ptr
    ; --- dispatch constructor (method named == class) ---
    <push ctor args>
    movea.l <target>, A0            ; self
    movea.l (A0), A1                ; descriptor
    movea.l (ctor_slot, A1), A1     ; method ptr
    jsr     (A1)
    lea     (4*nargs, A7), A7       ; pop args

(EC rebuilds the descriptor on each NEW; it is idempotent into the same slot.)

## `obj.method(args)`  (dispatch)

    <push args>                     ; each arg evaluated, move.l Dn,-(A7)
    movea.l obj, A0                 ; self in A0  (NOT on the stack)
    movea.l (A0), A1                ; descriptor = instance[0]
    movea.l (slot, A1), A1          ; method ptr = descriptor[M_OFF]
    jsr     (A1)
    lea     (4*nargs, A7), A7       ; pop args; result in D0

Method body prologue (proof): `link A5,#-n; move.l A0,(-4,A5)` (saves self
from A0), stack args read at `8(A5)`, `12(A5)`, … ; returns result in D0.

## `END obj`  (destructor + free)

    move.l  obj, D0
    beq     .skip                   ; NIL -> nothing
    move.l  D0, -(A7)               ; push obj (also passed as stack arg)
    movea.l D0, A0                  ; self
    movea.l (A0), A1                ; descriptor
    movea.l (odestr, A1), A1        ; destructor method ptr
    jsr     (A1)
    movea.l (A7), A0                ; reload obj
    movea.l (A0), A1                ; descriptor
    move.l  (A1), -(A7)             ; push descriptor[0] = OSIZE
    bsr     __dispose               ; free obj of OSIZE back to the pool
    addq.l  #8, A7
    clr.l   obj                     ; obj := NIL
    .skip:

## Implementation notes for ecomp

- `emitBinaryModules()` already blobs the module code; add a label at
  `modbase + delcode` (the builder) and reserve `delsize` bytes of globals for
  the descriptor + one slot for the descriptor pointer, per binary class.
- Detect binary classes (`sem.binaryClasses`) at the NEW / method-call / END
  sites and emit the vtable path above; leave source-class static dispatch
  untouched.
- `__new` / `__dispose` ifunc thunks already exist (pool alloc/free).
- Open limitation: a *source* class inheriting from a *binary* class would mix
  the two calling conventions — not yet handled; pure binary classes first.

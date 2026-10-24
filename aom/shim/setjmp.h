/* wasm32-wasi has no setjmp without exception handling. libaom only longjmps on internal errors,
   so setjmp always returns 0 and longjmp traps: an encoder error aborts the instance. */
#ifndef SOGV_SETJMP_H
#define SOGV_SETJMP_H
typedef int jmp_buf[1];
#define setjmp(env) ((void)(env), 0)
static inline __attribute__((noreturn)) void longjmp(jmp_buf env, int val) { (void)env; (void)val; __builtin_trap(); }
#endif

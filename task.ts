import asap from 'asap';

type Function = (...x: any[]) => any;
type ErrorFunction = (error: Error) => any;

enum TaskState {
    PENDING,
    FULFILLED,
    REJECTED,
}

const handlers = new WeakMap<Task | Completer, TaskHandler>();

/**
 * A cancelable variant of a promise. Like a promise, the observable is
 * a proxy for the result of some work. The interface is largely the
 * same, but an observable can only have one observer. For example
 * calling `then` a second time will throw an error. Instead, if
 * a task has multiple observes, you can sacrifice cancel-ability
 * by coercing it to a promise or by using `fork` before
 * observing it. If every fork is cancelled, the
 * cancellation will propagate back to the
 * original job.
 * 
 */
class Task {
    /**
     * Receives an observable and registers an observer for the
     * result of the task, and the ability to cancel the
     * task with an error.
     * 
     * @param setup The observer that can handle the result or the error
     * @param thisP The object context on which to call `setup`
     */
    constructor(setup: Function, thisP: any) {
        const deferred = Task.defer();
        const handler = handlers.get(deferred.out);
        if (handler) {
            handler.cancel = setup.call(thisP, deferred.in.return, deferred.in.throw);
        }
        return deferred.out;
    }

    /**
     * Creates a resolver "in" and an observer "out" pair
     * with some shared internal state.
     * 
     * @param cancel The cancellation method
     * @param thisP THe instance that hosts the cancellation
     */
    public static defer(cancel?: Function, thisP?: any): {
        in: Completer,
        out: Task,
    } {
        const handler = new TaskHandler();
        const input = Object.create(Completer.prototype);
        const output = Object.create(Task.prototype);
        Completer_bind(input);
        handlers.set(input, handler);
        handlers.set(output, handler);
        if (cancel) {
            handler.cancel = cancel;
        }
        if (thisP) {
            handler.cancelThisP = thisP;
        }

        return {
            in: input,
            out: output
        };
    }

    /**
     * Lifts a value into a task that has already
     * been completed with a value.
     * 
     * @param value The value to be lifted
     */
    public static return<T>(value: T): Task {
        if (Task.isTask(value)) {
            return value;
        }
        if (Task.isThenable(value)) {
            throw new Error('Thenable not implemented');
        }
        const handler = new TaskHandler();
        handler.state = TaskState.FULFILLED;
        handler.value = value;
        const task = Object.create(Task.prototype);
        handlers.set(task, handler);
        return task;
    }

    /**
     * Lifts an error into a task that has already
     * failed with that error.
     * 
     * @param error The error to be lifted
     */
    public static throw(error: Error) {
        const handler = new TaskHandler();
        handler.state = TaskState.REJECTED;
        handler.error = error;
        const task = Object.create(Task.prototype);
        handlers.set(task, handler);
        return task;
    }

    /**
     * Accepts an array of tasks and produces a task
     * that when completed will produce an array
     * of the individual completion values.
     * 
     * If the task is cancelled, of if any individual
     * task fails, all of the outstanding individual
     * tasks will be cancelled.
     * 
     * Note that throwing an error upstream constitutes
     * talking back to the producer. This is a
     * reminder that tasks a cooperation between
     * a single consumer and a single producer
     * and that information flows both ways
     * and in fact allows information to
     * propagate laterally by passing
     * up one stream and down another.
     * 
     * @param tasks The tasks to be completed
     */
    public static all(tasks: Task[]) {
        const result = Task.defer(cancelAll);
        function cancelAll(error: Error) {
            tasks.forEach((task: Task) => task.throw(error));
            result.in.throw(error);
        }
    
        let remaining = tasks.length;
        const results = Array.from({ length: tasks.length });
        tasks.forEach(function Task_all_each(task: Task, index: number) {
            task = tasks[index] = Task.return(task);
            task.done(function Task_all_anyReturn(value: any) {
                results[index] = value;
                if (--remaining === 0) {
                    result.in.return(results);
                }
            }, cancelAll);
        });
        return result.out;
    }

    /**
     * Accepts a duration of time and returns a task that
     * will complete with the given value after that
     * amount of time has elapsed.
     * 
     * @param ms The amount of time in milliseconds after which to resolve the task
     * @param value The value with which to resolve the task
     */
    public static delay<T>(ms: number, value: T) {
        return Task.return(value).delay(ms);
    }
    
    /**
     * Register an observer for any combination of completion or failure with the given
     * methods and optional context object. Does not return a new task and does not
     * capture errors through by the observer methods.
     * 
     * @param onReturn The function to call after the handler has completed successfully
     * @param onThrow The function to call after the handler is cancelled or errors out
     * @param thisP The context object on which to call the above functions
     */
    public done(onReturn?: Function, onThrow?: ErrorFunction, thisP?: any) {
        const self = this;
        const handler = Task_getHandler(self);
        handler.done(onReturn, onThrow, thisP);
    }

    /**
     * Registers an observer for any combination of completion or failure, and creates
     * a new task that will be completed with the result of either the completion
     * or failure handler.
     * 
     * @param onReturn The function to call after the handler has completed successfully
     * @param onThrow The function to call after the handler is cancelled or errors out
     * @param thisP The context object on which to call the above functions
     */
    public then(onReturn?: Function, onThrow?: ErrorFunction, thisP?: any) {
        const handler = Task_getHandler(this);
        const task = Task.defer(handler.cancel || undefined, this);
        let _onReturn, _onThrow;
        if (typeof onReturn === 'function') {
            _onReturn = (value: any) => {
                try {
                    task.in.return(onReturn.call(thisP, value));
                } catch (error) {
                    task.in.throw(error);
                }
            };
        }
        if (typeof onThrow === 'function') {
            _onThrow = (error: Error) => {
                try {
                    task.in.return(onThrow.call(thisP, error));
                } catch (error) {
                    task.in.throw(error);
                }
            };
        }
        this.done(_onReturn, _onThrow);
        return task.out;
    }

    /**
     * Registers an error observer on a task and returns a new
     * task to be completed with the result of the observer.
     * The observer may return another task or thenable
     * to transfer responsibility to complete this
     * task to another stage of the process.
     * 
     * @param onThrow the error observer to register on the task
     * @param thisP The object context on which to throw the error
     */
    public catch(onThrow: ErrorFunction, thisP: any) {
        return this.then(undefined, onThrow, thisP);
    }

    /**
     * Registers an observer for when the task either completes or
     * fails and returns a new task to perform some further work
     * but forward the original value or error otherwise.
     * 
     * @param onSettle The task to perform before forwarding value or error
     * @param thisP The object context on which to call the settle
     */
    public finally(onSettle: Function, thisP: any) {
        return this.then(function (value) {
            return onSettle.call(thisP).then(function Task_finally_value() {
                return value;
            });
        }, function (error: Error) {
            return onSettle.call(thisP).then(function Task_finally_error() {
                throw error;
            })
        })
    }

    /**
     * Creates a task that will get a property of the completion
     * object for this task.
     * 
     * @param key The property of the completion object to return
     */
    public get<T>(key: string) {
        return this.then(function (object: { [key:string]: T }) {
            return object[key];
        });
    }

    /**
     * Creates a task that will call the function that is the
     * completion value of this task with the given spread
     * arguments.
     * 
     * @param thisP The context object for the completion call
     * @param args The arguments to pass to the completion call
     */
    public call(thisP: any, ...args: any[]) {
        return this.then(function (callable) {
            return callable.apply(thisP, args);
        });
    }

    /**
     * Creates a task that will invoke a property of the completion
     * object for this task.
     * 
     * @param name The property of the completion object to invoke
     * @param args The arguments to pass to the completion object
     */
    public invoke(name: string, ...args: any[]) {
        return this.then(function (object: { [key: string]: Function }) {
            return object[name].apply(object, args);
        });
    }

    /**
     * Registers an observer for the completion of this task
     * and returns a task that will be completed with the
     * given value when this task is completed.
     * 
     * @param value The value with which to complete the task
     */
    public thenReturn<T>(value: T) {
        return this.then(function () {
            return value;
        });
    }

    /**
     * Registers an observer for the completion of this task
     * and returns a task that will fail with the given
     * error when this task is completed.
     * 
     * @param error The failure with which to complete the task
     */
    public thenThrow(error: Error) {
        return this.then(function () {
            return error;
        });
    }

    /**
     * Effects cancellation from the consumer side.
     * 
     * @param error The error to be thrown
     */
    public throw(error?: Error) {
        const handler = Task_getHandler(this);
        if (handler.cancel) {
            handler.throw(error);
        }
    }

    /**
     * Returns a new task that will observe the same completion
     * or failure of this task. Hereafter, this task and
     * all forked tasks must ALL be cancelled for
     * this task's canceller to propagate.
     */
    public fork() {
        const parentHandler = Task_getHandler(this);
        let leftCanceled = false;
        let rightCanceled = false;
        const left = Task.defer(function (error: Error) {
            if (leftCanceled) {
                return;
            }
            leftCanceled = true;
            if (rightCanceled) {
                parentHandler.throw(error);
            }
        });
        const right = Task.defer(function (error: Error) {
            if (rightCanceled) {
                return;
            }
            rightCanceled = true;
            if (leftCanceled) {
                parentHandler.throw(error);
            }
        });
    
        parentHandler.done(function <T>(value: T) {
            left.in.return(value);
            right.in.return(value);
        }, function (error: Error) {
            left.in.throw(error);
            right.in.throw(error);
        });
    
        handlers.set(this, Task_getHandler(left.out));
        return right.out;
    }

    /**
     * Adds a delay of some milliseconds after the task
     * COMPLETES. Cancelling the delayed task will
     * cancel either the delay or the
     * delayed task.
     * 
     * @param ms The time in milliseconds to delay
     */
    public delay(ms: number) {
        const self = this;
        const result = Task.defer();
        const handle = setTimeout(function taskDelayed() {
            task.in.return(result.out);
        }, ms);
        const task = Task.defer(function cancelDelayedTask() {
            self.throw();
            clearTimeout(handle);
        });
        this.done(function (value: any) {
            result.in.return(value);
        }, function (error: Error) {
            task.in.throw(error);
        });
        return task.out;
    }

    /**
     * Cancels a task if it takes longer than a given delay
     * in milliseconds.
     * 
     * @param ms The time in milliseconds after which to cancel the task
     * @param message The error message to pass to the timeout
     */
    public timeout(ms: number, message: string) {
        const self = this;
        const handle = setTimeout(function Task_timeout() {
            self.throw();
            task.in.throw(new Error(message || `Timed out after ${ms} ms`));
        }, ms);
        const task = Task.defer(function cancelTimeoutTask() {
            self.throw();
            clearTimeout(handle);
        });
        this.done(function Task_timeoutValue(value: any) {
            clearTimeout(handle);
            task.in.return(value);
        }, function Task_timeoutError(error: Error) {
            clearTimeout(handle);
            task.in.throw(error);
        });
        return task.out;
    }

        /**
     * Identifies if the incoming object is a `Task`.
     * 
     * @param object the object that may be a Task
     */
    private static isTask(object: any): object is Task {
        return Object(object) === object &&
            !handlers.get(object) &&
            object instanceof Task;
    }

    
    /**
     * Identifies other singular asynchronous duck types,
     * including promises, which can be coerced
     * into tasks.
     * 
     * @param object The object that may be a thennable
     */
    private static isThenable(object: any): object is { then: Function } {
        return Object(object) === object && typeof object.then === 'function';
    }
}

/**
 * The shared internal state between a resolver and an
 * observable side of a task.
 */
class TaskHandler {
    /**
     * When a task is resolved, it "becomes" a different task
     * and its observable, if any, must be forwarded to the
     * new task handler. In the `become` method, we also
     * adjust the "handlers" table so any subsequent
     * request for this handler jumps to the end
     * of the "became" chain.
     */
    public became: TaskHandler | null = null;
    /**
     * Tasks must be created with a corresponding canceler.
     */
    public cancel: Function | null = null;
    public cancelThisP: any = null;
    /**
     * Tasks may be "PENDING", "FULFILLED" with a value,
     * or "REJECTED" with an error.
     */
    public state: TaskState = TaskState.PENDING;
    public value: any = null;
    public error: Error | null = null;
    /**
     * A task may only be observed once. Any future
     * attempts to observe a task will throw
     * an error.
     */
    public observed = false;
    /**
     * Since a task can only be observed once, we only
     * need to track one handler for fulfillment
     * with a value or rejection with an error.
     * A promise keeps an array of handlers
     * to forward messages to. These
     * handlers can be forgotten
     * once a task settles
     * since thereafter
     * the observer
     * would be
     * informed
     * immediately.
     */
    public onReturn: Function | null = null;
    public onThrow: ErrorFunction | null = null;
    /**
     * The object to use as `this` in the context
     * of `onReturn` and `onThrow`
     */
    public thisP: any = null;

    /**
     * Kernel for subscribing to a task observer. If the task has
     * already completed or failed, this will also arrange for
     * the observer to be notified as soon as possible.
     * 
     * @param onReturn the success method to subscribe
     * @param onThrow the error method to subscribe
     * @param thisP the `this` context for the onReturn and onError
     */
    done(onReturn?: Function, onThrow?: ErrorFunction, thisP?: any) {
        if (this.observed) {
            throw new Error("Can't observe a task multiple times. Use fork");
        }
        this.observed = true;
        if (onReturn) {
            this.onReturn = onReturn;
        }
        if (onThrow) {
            this.onThrow = onThrow;
        }

        this.thisP = thisP;

        if (this.state !== TaskState.PENDING) {
            asap(this);
        }
    }

    /**
     * Gets called if this task has settled into a "FULFILLED"
     * or "REJECTED" state so we can call the
     * appropriate handler.
     */
    call() {
        if (this.state === TaskState.FULFILLED) {
            if (this.onReturn) {
                this.onReturn.call(this.thisP, this.value);
            }
        } else if (this.state === TaskState.REJECTED) {
            if (this.onThrow && this.error) {
                this.onThrow.call(this.thisP, this.error);
            } else {
                throw this.error;
            }
        }

        // Release the handlers so they can be potentially garbage collected.
        this.onReturn = null;
        this.onThrow = null;
        this.thisP = null;
    }

    /**
     * Kernel of the task resolver.
     * 
     * @param task the task to resolve
     */
    become(task: Task) {
        const handler = Task_getHandler(task);

        // A task can only be resolved once. Subsequent resolutions
        // are ignored. Ignoring, rather than throwing an error,
        // greatly simplifies a number of cases, like racing
        // task and cancelling tasks, where handling an
        // error would be unnecessary
        // and inconvenient.
        if (this.state !== TaskState.PENDING) {
            return;
        }

        // The `became` property gets used by the internal handler
        // getter to rewrite the handler table and shorten chains
        this.became = handler;

        // Once a task completes or fails, we no longer need to
        // retain the canceler
        this.cancel = null;
        this.cancelThisP = null;

        // If an observer subscribed before it completed or failed,
        // we forward the resolution. If an observer subscribes
        // later, we take care of that case in `done`.
        if (this.observed) {
            handler.done(this.onReturn || undefined, this.onThrow || undefined, this.thisP);
        }
    }

    /**
     * Used by the promise observer to cancel the task
     * from the consumer side
     * @param error the error to throw
     */
    throw(error?: Error) {
        if (typeof this.cancel === 'function') {
            this.cancel.call(this.cancelThisP);
        }
        this.become(Task.throw(error || new Error('Consumer canceled task')));
    }
}

/**
 * The producer side of a task should get a reference to a task's
 * resolver. This object provides the capability to settle the
 * task with a completion value or failure error
 */
class Completer {
    constructor() {
        this.return = this.return.bind(this);
        this.throw = this.throw.bind(this);
    }

    /**
     * Sets the task state to "FULFILLED" or "COMPLETED" with a
     * given value. If the corresponding observer was registered
     * already, this will inform the observer as soon as
     * possible. If the corresponding observer gets
     * registered later, it will receive the result
     * as soon as possible thereafter
     * 
     * @param value the value with which to resolve the task
     */
    return<T>(value: T) {
        const handler: TaskHandler = Task_getHandler(this);
        handler.become(Task.return(value));
    }
    
    /**
     * Sets the task state to "REJECTED" or "FAILED" with
     * the given error. If the corresponding observer was registered
     * already, this will inform the observer as soon as
     * possible. If the corresponding observer gets
     * registered later, it will receive the result
     * as soon as possible thereafter
     * 
     * @param error The error with which to resolve the task
     */
    throw(error: Error) {
        const handler: TaskHandler = Task_getHandler(this);
        handler.become(Task.throw(error));
    }
}

/**
 * The means by which the return and throw are bound to the
 * Completer outside of the Completer context
 * 
 * @param completer The completer to bind
 */
function Completer_bind(completer: Completer) {
    completer.return = completer.return.bind(completer);
    completer.throw = completer.throw.bind(completer);
}

/**
 * Since a task handler can become another task handler,
 * this utility method will look up the end of the
 * chain of "become" properties and rewrite the
 * handler look up table so we never have to
 * walk the same length of chain again.
 * 
 * @param task the task whose "became" chain we are travelling
 */
function Task_getHandler(task: Task | Completer): TaskHandler {
    let handler = handlers.get(task);
    while (handler && handler.became != null) {
        handler = handler.became;
    }
    if (!handler) throw new Error('HOW DID YOU FUCK THIS UP?');

    handlers.set(task, handler);
    return handler;
}

export default Task;

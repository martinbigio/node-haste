 /**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

const debug = require('debug')('ReactNativePackager:DependencyGraph');
const util = require('util');
const path = require('fast-path');
const realPath = require('path');
const isAbsolutePath = require('absolute-path');
const getAssetDataFromName = require('../lib/getAssetDataFromName');
const Promise = require('promise');
const throat = require('throat')(Promise);

const MAX_CONCURRENT_FILE_READS = 32;
const getDependencies = throat(
  MAX_CONCURRENT_FILE_READS,
  (module, transformOptions) => module.getDependencies(transformOptions)
);

class ResolutionRequest {
  constructor({
    platform,
    preferNativePlatform,
    entryPath,
    hasteMap,
    deprecatedAssetMap,
    helpers,
    moduleCache,
    fastfs,
    shouldThrowOnUnresolvedErrors,
  }) {
    this._platform = platform;
    this._preferNativePlatform = preferNativePlatform;
    this._entryPath = entryPath;
    this._hasteMap = hasteMap;
    this._deprecatedAssetMap = deprecatedAssetMap;
    this._helpers = helpers;
    this._moduleCache = moduleCache;
    this._fastfs = fastfs;
    this._shouldThrowOnUnresolvedErrors = shouldThrowOnUnresolvedErrors;
    this._resetResolutionCache();
  }

  _tryResolve(action, secondaryAction) {
    return action().catch((error) => {
      if (error.type !== 'UnableToResolveError') {
        throw error;
      }
      return secondaryAction();
    });
  }

  resolveDependency(fromModule, toModuleName) {
    const resHash = resolutionHash(fromModule.path, toModuleName);

    if (this._immediateResolutionCache[resHash]) {
      return Promise.resolve(this._immediateResolutionCache[resHash]);
    }

    const asset_DEPRECATED = this._deprecatedAssetMap.resolve(
      fromModule,
      toModuleName
    );
    if (asset_DEPRECATED) {
      return Promise.resolve(asset_DEPRECATED);
    }

    const cacheResult = (result) => {
      this._immediateResolutionCache[resHash] = result;
      return result;
    };

    const forgive = (error) => {
      if (
        error.type !== 'UnableToResolveError' ||
        this._shouldThrowOnUnresolvedErrors(this._entryPath, this._platform)
      ) {
        throw error;
      }

      debug(
        'Unable to resolve module %s from %s',
        toModuleName,
        fromModule.path
      );
      return null;
    };

    if (!this._helpers.isNodeModulesDir(fromModule.path)
        && toModuleName[0] !== '.' &&
        toModuleName[0] !== '/') {
      return this._tryResolve(
        () => this._resolveHasteDependency(fromModule, toModuleName),
        () => this._resolveNodeDependency(fromModule, toModuleName)
      ).then(
        cacheResult,
        forgive,
      );
    }

    return this._resolveNodeDependency(fromModule, toModuleName)
      .then(
        cacheResult,
        forgive,
      );
  }

  getOrderedDependencies({
    response,
    mocksPattern,
    transformOptions,
    onProgress,
    recursive = true,
  }) {
    return this._getAllMocks(mocksPattern).then(allMocks => {
      const entry = this._moduleCache.getModule(this._entryPath);
      const mocks = Object.create(null);
      const visited = Object.create(null);
      visited[entry.hash()] = true;

      response.pushDependency(entry);
      let totalModules = 1;
      let finishedModules = 0;

      const collect = (mod) => {
        return getDependencies(mod, transformOptions).then(
          depNames => Promise.all(
            depNames.map(name => this.resolveDependency(mod, name))
          ).then((dependencies) => [depNames, dependencies])
        ).then(([depNames, dependencies]) => {
          if (allMocks) {
            const list = [mod.getName()];
            const pkg = mod.getPackage();
            if (pkg) {
              list.push(pkg.getName());
            }
            return Promise.all(list).then(names => {
              names.forEach(name => {
                if (allMocks[name] && !mocks[name]) {
                  const mockModule =
                    this._moduleCache.getModule(allMocks[name]);
                  depNames.push(name);
                  dependencies.push(mockModule);
                  mocks[name] = allMocks[name];
                }
              });
              return [depNames, dependencies];
            });
          }
          return [depNames, dependencies];
        }).then(([depNames, dependencies]) => {
          const filteredPairs = [];

          dependencies.forEach((modDep, i) => {
            const name = depNames[i];
            if (modDep == null) {
              // It is possible to require mocks that don't have a real
              // module backing them. If a dependency cannot be found but there
              // exists a mock with the desired ID, resolve it and add it as
              // a dependency.
              if (allMocks && allMocks[name] && !mocks[name]) {
                const mockModule = this._moduleCache.getModule(allMocks[name]);
                mocks[name] = allMocks[name];
                return filteredPairs.push([name, mockModule]);
              }

              debug(
                'WARNING: Cannot find required module `%s` from module `%s`',
                name,
                mod.path
              );
              return false;
            }
            return filteredPairs.push([name, modDep]);
          });

          response.setResolvedDependencyPairs(mod, filteredPairs);

          const newDependencies =
            filteredPairs.filter(([, modDep]) => !visited[modDep.hash()]);

          if (onProgress) {
            finishedModules += 1;
            totalModules += newDependencies.length;
            onProgress(finishedModules, totalModules);
          }
          return Promise.all(
            newDependencies.map(([depName, modDep]) => {
              visited[modDep.hash()] = true;
              return Promise.all([modDep, recursive ? collect(modDep) : []]);
            })
          );
        });
      };

      return collect(entry).then(deps => {
        recursiveFlatten(deps).forEach(dep => response.pushDependency(dep));
        response.setMocks(mocks);
      });
    });
  }

  _getAllMocks(pattern) {
    // Take all mocks in all the roots into account. This is necessary
    // because currently mocks are global: any module can be mocked by
    // any mock in the system.
    let mocks = null;
    if (pattern) {
      mocks = Object.create(null);
      this._fastfs.matchFilesByPattern(pattern).forEach(file =>
        mocks[path.basename(file, path.extname(file))] = file
      );
    }
    return Promise.resolve(mocks);
  }

  _resolveHasteDependency(fromModule, toModuleName) {
    toModuleName = normalizePath(toModuleName);

    let p = fromModule.getPackage();
    if (p) {
      p = p.redirectRequire(toModuleName);
    } else {
      p = Promise.resolve(toModuleName);
    }

    return p.then((realModuleName) => {
      let dep = this._hasteMap.getModule(realModuleName, this._platform);
      if (dep && dep.type === 'Module') {
        return dep;
      }

      let packageName = realModuleName;
      while (packageName && packageName !== '.') {
        dep = this._hasteMap.getModule(packageName, this._platform);
        if (dep && dep.type === 'Package') {
          break;
        }
        packageName = path.dirname(packageName);
      }

      if (dep && dep.type === 'Package') {
        const potentialModulePath = path.join(
          dep.root,
          path.relative(packageName, realModuleName)
        );
        return this._tryResolve(
          () => this._loadAsFile(
            potentialModulePath,
            fromModule,
            toModuleName,
          ),
          () => this._loadAsDir(potentialModulePath, fromModule, toModuleName),
        );
      }

      throw new UnableToResolveError(
        fromModule,
        toModuleName,
        'Unable to resolve dependency',
      );
    });
  }

  _redirectRequire(fromModule, modulePath) {
    return Promise.resolve(fromModule.getPackage()).then(p => {
      if (p) {
        return p.redirectRequire(modulePath);
      }
      return modulePath;
    });
  }

  _resolveFileOrDir(fromModule, toModuleName) {
    const potentialModulePath = isAbsolutePath(toModuleName) ?
        toModuleName :
        path.join(path.dirname(fromModule.path), toModuleName);

    return this._redirectRequire(fromModule, potentialModulePath).then(
      realModuleName => this._tryResolve(
        () => this._loadAsFile(realModuleName, fromModule, toModuleName),
        () => this._loadAsDir(realModuleName, fromModule, toModuleName)
      )
    );
  }

  _resolveNodeDependency(fromModule, toModuleName) {
    if (toModuleName[0] === '.' || toModuleName[1] === '/') {
      return this._resolveFileOrDir(fromModule, toModuleName);
    } else {
      return this._redirectRequire(fromModule, toModuleName).then(
        realModuleName => {
          if (realModuleName[0] === '.' || realModuleName[1] === '/') {
            // derive absolute path /.../node_modules/fromModuleDir/realModuleName
            const fromModuleParentIdx = fromModule.path.lastIndexOf('node_modules/') + 13;
            const fromModuleDir = fromModule.path.slice(0, fromModule.path.indexOf('/', fromModuleParentIdx));
            const absPath = path.join(fromModuleDir, realModuleName);
            return this._resolveFileOrDir(fromModule, absPath);
          }

          const searchQueue = [];
          for (let currDir = path.dirname(fromModule.path);
               currDir !== realPath.parse(fromModule.path).root;
               currDir = path.dirname(currDir)) {
            searchQueue.push(
              path.join(currDir, 'node_modules', realModuleName)
            );
          }

          let p = Promise.reject(new UnableToResolveError(
            fromModule,
            toModuleName,
            'Node module not found',
          ));
          searchQueue.forEach(potentialModulePath => {
            p = this._tryResolve(
              () => this._tryResolve(
                () => p,
                () => this._loadAsFile(potentialModulePath, fromModule, toModuleName),
              ),
              () => this._loadAsDir(potentialModulePath, fromModule, toModuleName)
            );
          });

          return p;
        });
    }
  }

  _loadAsFile(potentialModulePath, fromModule, toModule) {
    return Promise.resolve().then(() => {
      if (this._helpers.isAssetFile(potentialModulePath)) {
        const dirname = path.dirname(potentialModulePath);
        if (!this._fastfs.dirExists(dirname)) {
          throw new UnableToResolveError(
            fromModule,
            toModule,
            `Directory ${dirname} doesn't exist`,
          );
        }

        const {name, type} = getAssetDataFromName(potentialModulePath);

        let pattern = '^' + name + '(@[\\d\\.]+x)?';
        if (this._platform != null) {
          pattern += '(\\.' + this._platform + ')?';
        }
        pattern += '\\.' + type;

        // We arbitrarly grab the first one, because scale selection
        // will happen somewhere
        const [assetFile] = this._fastfs.matches(
          dirname,
          new RegExp(pattern)
        );

        if (assetFile) {
          return this._moduleCache.getAssetModule(assetFile);
        }
      }

      let file;
      if (this._fastfs.fileExists(potentialModulePath)) {
        file = potentialModulePath;
      } else if (this._platform != null &&
                 this._fastfs.fileExists(potentialModulePath + '.' + this._platform + '.js')) {
        file = potentialModulePath + '.' + this._platform + '.js';
      } else if (this._preferNativePlatform &&
                 this._fastfs.fileExists(potentialModulePath + '.native.js')) {
        file = potentialModulePath + '.native.js';
      } else if (this._fastfs.fileExists(potentialModulePath + '.js')) {
        file = potentialModulePath + '.js';
      } else if (this._fastfs.fileExists(potentialModulePath + '.json')) {
        file = potentialModulePath + '.json';
      } else {
        throw new UnableToResolveError(
          fromModule,
          toModule,
          `File ${potentialModulePath} doesnt exist`,
        );
      }

      return this._moduleCache.getModule(file);
    });
  }

  _loadAsDir(potentialDirPath, fromModule, toModule) {
    return Promise.resolve().then(() => {
      if (!this._fastfs.dirExists(potentialDirPath)) {
        throw new UnableToResolveError(
          fromModule,
          toModule,
`Unable to find this module in its module map or any of the node_modules directories under ${potentialDirPath} and its parent directories

This might be related to https://github.com/facebook/react-native/issues/4968
To resolve try the following:
  1. Clear watchman watches: \`watchman watch-del-all\`.
  2. Delete the \`node_modules\` folder: \`rm -rf node_modules && npm install\`.
  3. Reset packager cache: \`rm -fr $TMPDIR/react-*\` or \`npm start -- --reset-cache\`.`,
        );
      }

      const packageJsonPath = path.join(potentialDirPath, 'package.json');
      if (this._fastfs.fileExists(packageJsonPath)) {
        return this._moduleCache.getPackage(packageJsonPath)
          .getMain().then(
            (main) => this._tryResolve(
              () => this._loadAsFile(main, fromModule, toModule),
              () => this._loadAsDir(main, fromModule, toModule)
            )
          );
      }

      return this._loadAsFile(
        path.join(potentialDirPath, 'index'),
        fromModule,
        toModule,
      );
    });
  }

  _resetResolutionCache() {
    this._immediateResolutionCache = Object.create(null);
  }

}


function resolutionHash(modulePath, depName) {
  return `${path.resolve(modulePath)}:${depName}`;
}


function UnableToResolveError(fromModule, toModule, message) {
  Error.call(this);
  Error.captureStackTrace(this, this.constructor);
  this.message = util.format(
    'Unable to resolve module %s from %s: %s',
    toModule,
    fromModule.path,
    message,
  );
  this.type = this.name = 'UnableToResolveError';
}

util.inherits(UnableToResolveError, Error);

function normalizePath(modulePath) {
  if (path.sep === '/') {
    modulePath = path.normalize(modulePath);
  } else if (path.posix) {
    modulePath = path.posix.normalize(modulePath);
  }

  return modulePath.replace(/\/$/, '');
}

function recursiveFlatten(array) {
  return Array.prototype.concat.apply(
    Array.prototype,
    array.map(item => Array.isArray(item) ? recursiveFlatten(item) : item)
  );
}

module.exports = ResolutionRequest;

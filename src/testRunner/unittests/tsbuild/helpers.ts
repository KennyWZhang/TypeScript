namespace ts {
    export function getExpectedDiagnosticForProjectsInBuild(...projects: string[]): fakes.ExpectedDiagnostic {
        return [Diagnostics.Projects_in_this_build_Colon_0, projects.map(p => "\r\n    * " + p).join("")];
    }

    export function replaceText(fs: vfs.FileSystem, path: string, oldText: string, newText: string) {
        if (!fs.statSync(path).isFile()) {
            throw new Error(`File ${path} does not exist`);
        }
        const old = fs.readFileSync(path, "utf-8");
        if (old.indexOf(oldText) < 0) {
            throw new Error(`Text "${oldText}" does not exist in file ${path}`);
        }
        const newContent = old.replace(oldText, newText);
        fs.writeFileSync(path, newContent, "utf-8");
    }

    export function prependText(fs: vfs.FileSystem, path: string, additionalContent: string) {
        if (!fs.statSync(path).isFile()) {
            throw new Error(`File ${path} does not exist`);
        }
        const old = fs.readFileSync(path, "utf-8");
        fs.writeFileSync(path, `${additionalContent}${old}`, "utf-8");
    }

    export function appendText(fs: vfs.FileSystem, path: string, additionalContent: string) {
        if (!fs.statSync(path).isFile()) {
            throw new Error(`File ${path} does not exist`);
        }
        const old = fs.readFileSync(path, "utf-8");
        fs.writeFileSync(path, `${old}${additionalContent}`);
    }

    export function getTime() {
        let currentTime = 100;
        return { tick, time, touch };

        function tick() {
            currentTime += 60_000;
        }

        function time() {
            return currentTime;
        }

        function touch(fs: vfs.FileSystem, path: string) {
            if (!fs.statSync(path).isFile()) {
                throw new Error(`File ${path} does not exist`);
            }
            fs.utimesSync(path, new Date(time()), new Date(time()));
        }
    }

    export function loadProjectFromDisk(root: string, time?: vfs.FileSystemOptions["time"]): vfs.FileSystem {
        const resolver = vfs.createResolver(Harness.IO);
        const fs = new vfs.FileSystem(/*ignoreCase*/ true, {
            files: {
                ["/lib"]: new vfs.Mount(vpath.resolve(Harness.IO.getWorkspaceRoot(), "built/local"), resolver),
                ["/src"]: new vfs.Mount(vpath.resolve(Harness.IO.getWorkspaceRoot(), root), resolver)
            },
            cwd: "/",
            meta: { defaultLibLocation: "/lib" },
            time
        });
        fs.makeReadonly();
        return fs;
    }

    export function getLibs() {
        return [
            "/lib/lib.d.ts",
            "/lib/lib.es5.d.ts",
            "/lib/lib.dom.d.ts",
            "/lib/lib.webworker.importscripts.d.ts",
            "/lib/lib.scripthost.d.ts"
        ];
    }

    function generateSourceMapBaselineFiles(fs: vfs.FileSystem, mapFileNames: ReadonlyArray<string>) {
        for (const mapFile of mapFileNames) {
            if (!fs.existsSync(mapFile)) continue;
            const text = Harness.SourceMapRecorder.getSourceMapRecordWithVFS(fs, mapFile);
            fs.writeFileSync(`${mapFile}.baseline.txt`, text);
        }
    }

    // [tsbuildinfo, js, dts]
    export type BuildInfoSectionBaselineFiles = [string, string | undefined, string | undefined];
    function generateBuildInfoSectionBaselineFiles(fs: vfs.FileSystem, buildInfoFileNames: ReadonlyArray<BuildInfoSectionBaselineFiles>) {
        for (const [file, jsFile, dtsFile] of buildInfoFileNames) {
            if (!fs.existsSync(file)) continue;

            const buildInfo = JSON.parse(fs.readFileSync(file, "utf8")) as BuildInfo;
            const bundle = buildInfo.bundle;
            if (!bundle || (!length(bundle.js && bundle.js.sections) && !length(bundle.dts && bundle.dts.sections))) continue;

            // Write the baselines:
            const baselineRecorder = new Harness.Compiler.WriterAggregator();
            generateBundleFileSectionInfo(fs, baselineRecorder, bundle.js, jsFile);
            generateBundleFileSectionInfo(fs, baselineRecorder, bundle.dts, dtsFile);
            baselineRecorder.Close();

            const text = baselineRecorder.lines.join("\r\n");
            fs.writeFileSync(`${file}.baseline.txt`, text, "utf8");
        }
    }

    function generateBundleFileSectionInfo(fs: vfs.FileSystem, baselineRecorder: Harness.Compiler.WriterAggregator, bundleFileInfo: BundleFileInfo | undefined, outFile: string | undefined) {
        if (!length(bundleFileInfo && bundleFileInfo.sections) && !outFile) return; // Nothing to baseline

        const content = outFile && fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
        baselineRecorder.WriteLine("======================================================================");
        baselineRecorder.WriteLine(`File:: ${outFile}`);
        for (const section of bundleFileInfo ? bundleFileInfo.sections : emptyArray) {
            baselineRecorder.WriteLine("----------------------------------------------------------------------");
            writeSectionHeader(section);
            if (section.kind !== BundleFileSectionKind.Prepend) {
                writeTextOfSection(section.pos, section.end);
            }
            else {
                Debug.assert(section.pos === first(section.texts).pos);
                Debug.assert(section.end === last(section.texts).end);
                for (const text of section.texts) {
                    baselineRecorder.WriteLine(">>--------------------------------------------------------------------");
                    writeSectionHeader(text);
                    writeTextOfSection(text.pos, text.end);
                }
            }
        }
        baselineRecorder.WriteLine("======================================================================");

        function writeTextOfSection(pos: number, end: number) {
            const textLines = content.substring(pos, end).split(/\r?\n/);
            for (const line of textLines) {
                baselineRecorder.WriteLine(line);
            }
        }

        function writeSectionHeader(section: BundleFileSection) {
            baselineRecorder.WriteLine(`${section.kind}: (${section.pos}-${section.end})${section.data ? ":: " + section.data : ""}${section.kind === BundleFileSectionKind.Prepend ? " texts:: " + section.texts.length : ""}`);
        }
    }

    interface BuildInput {
        fs: vfs.FileSystem;
        tick: () => void;
        rootNames: ReadonlyArray<string>;
        expectedMapFileNames: ReadonlyArray<string>;
        expectedBuildInfoFilesForSectionBaselines?: ReadonlyArray<BuildInfoSectionBaselineFiles>;
        modifyFs: (fs: vfs.FileSystem) => void;
    }

    function build({ fs, tick, rootNames, expectedMapFileNames, expectedBuildInfoFilesForSectionBaselines, modifyFs }: BuildInput) {
        const actualReadFileMap = createMap<number>();
        modifyFs(fs);
        tick();

        const host = new fakes.SolutionBuilderHost(fs);
        const builder = createSolutionBuilder(host, rootNames, { dry: false, force: false, verbose: true });
        host.clearDiagnostics();
        const originalReadFile = host.readFile;
        host.readFile = path => {
            // Dont record libs
            if (path.startsWith("/src/")) {
                actualReadFileMap.set(path, (actualReadFileMap.get(path) || 0) + 1);
            }
            return originalReadFile.call(host, path);
        };
        builder.buildAllProjects();
        generateSourceMapBaselineFiles(fs, expectedMapFileNames);
        generateBuildInfoSectionBaselineFiles(fs, expectedBuildInfoFilesForSectionBaselines || emptyArray);
        fs.makeReadonly();
        return { fs, actualReadFileMap, host, builder };
    }

    function generateBaseline(fs: vfs.FileSystem, proj: string, scenario: string, subScenario: string, baseFs: vfs.FileSystem) {
        const patch = fs.diff(baseFs);
        // tslint:disable-next-line:no-null-keyword
        Harness.Baseline.runBaseline(`tsbuild/${proj}/${subScenario.split(" ").join("-")}/${scenario.split(" ").join("-")}.js`, patch ? vfs.formatPatch(patch) : null);
    }

    function verifyReadFileCalls(actualReadFileMap: Map<number>, expectedReadFiles: ReadonlyMap<number>) {
        TestFSWithWatch.verifyMapSize("readFileCalls", actualReadFileMap, arrayFrom(expectedReadFiles.keys()));
        expectedReadFiles.forEach((expected, expectedFile) => {
            const actual = actualReadFileMap.get(expectedFile);
            assert.equal(actual, expected, `Mismatch in read file call number for: ${expectedFile}
Not in Actual: ${JSON.stringify(arrayFrom(mapDefinedIterator(expectedReadFiles.keys(), f => actualReadFileMap.has(f) ? undefined : f)))}
Mismatch Actual(path, actual, expected): ${JSON.stringify(arrayFrom(mapDefinedIterator(actualReadFileMap.entries(),
                ([p, v]) => expectedReadFiles.get(p) !== v ? [p, v, expectedReadFiles.get(p) || 0] : undefined)))}`);
        });
    }

    export function getReadFilesMap(filesReadOnce: ReadonlyArray<string>, ...filesWithTwoReadCalls: string[]) {
        const map = arrayToMap(filesReadOnce, identity, () => 1);
        for (const fileWithTwoReadCalls of filesWithTwoReadCalls) {
            map.set(fileWithTwoReadCalls, 2);
        }
        return map;
    }

    export interface ExpectedBuildOutput {
        expectedDiagnostics?: ReadonlyArray<fakes.ExpectedDiagnostic>;
        expectedReadFiles?: ReadonlyMap<number>;
    }

    export interface BuildState extends ExpectedBuildOutput {
        modifyFs: (fs: vfs.FileSystem) => void;
    }

    export interface VerifyTsBuildInput {
        scenario: string;
        projFs: () => vfs.FileSystem;
        time: () => number;
        tick: () => void;
        proj: string;
        rootNames: ReadonlyArray<string>;
        expectedMapFileNames: ReadonlyArray<string>;
        expectedBuildInfoFilesForSectionBaselines?: ReadonlyArray<BuildInfoSectionBaselineFiles>;
        lastProjectOutputJs: string;
        initialBuild: BuildState;
        outputFiles?: ReadonlyArray<string>;
        incrementalDtsChangedBuild?: BuildState;
        incrementalDtsUnchangedBuild?: BuildState;
        incrementalHeaderChangedBuild?: BuildState;
        baselineOnly?: true;
    }

    export function verifyTsbuildOutput({
        scenario, projFs, time, tick, proj, rootNames, outputFiles, baselineOnly,
        expectedMapFileNames, expectedBuildInfoFilesForSectionBaselines, lastProjectOutputJs,
        initialBuild, incrementalDtsChangedBuild, incrementalDtsUnchangedBuild, incrementalHeaderChangedBuild
    }: VerifyTsBuildInput) {
        describe(`tsc --b ${proj}:: ${scenario}`, () => {
            let fs: vfs.FileSystem;
            let actualReadFileMap: Map<number>;
            let firstBuildTime: number;
            let host: fakes.SolutionBuilderHost;
            before(() => {
                const result = build({
                    fs: projFs().shadow(),
                    tick,
                    rootNames,
                    expectedMapFileNames,
                    expectedBuildInfoFilesForSectionBaselines,
                    modifyFs: initialBuild.modifyFs,
                });
                ({ fs, actualReadFileMap, host } = result);
                firstBuildTime = time();
            });
            after(() => {
                fs = undefined!;
                actualReadFileMap = undefined!;
                host = undefined!;
            });
            describe("initialBuild", () => {
                if (!baselineOnly) {
                    it(`verify diagnostics`, () => {
                        host.assertDiagnosticMessages(...(initialBuild.expectedDiagnostics || emptyArray));
                    });
                }
                it(`Generates files matching the baseline`, () => {
                    generateBaseline(fs, proj, scenario, "initial Build", projFs());
                });
                if (!baselineOnly) {
                    it("verify readFile calls", () => {
                        verifyReadFileCalls(actualReadFileMap, Debug.assertDefined(initialBuild.expectedReadFiles));
                    });
                }
            });

            function incrementalBuild(subScenario: string, incrementalModifyFs: (fs: vfs.FileSystem) => void, incrementalExpectedDiagnostics: ReadonlyArray<fakes.ExpectedDiagnostic> | undefined, incrementalExpectedReadFiles: ReadonlyMap<number> | undefined) {
                describe(subScenario, () => {
                    let newFs: vfs.FileSystem;
                    let actualReadFileMap: Map<number>;
                    let host: fakes.SolutionBuilderHost;
                    before(() => {
                        assert.equal(fs.statSync(lastProjectOutputJs).mtimeMs, firstBuildTime, "First build timestamp is correct");
                        tick();
                        newFs = fs.shadow();
                        tick();
                        ({ actualReadFileMap, host } = build({
                            fs: newFs,
                            tick,
                            rootNames,
                            expectedMapFileNames,
                            expectedBuildInfoFilesForSectionBaselines,
                            modifyFs: incrementalModifyFs,
                        }));
                        assert.equal(newFs.statSync(lastProjectOutputJs).mtimeMs, time(), "Second build timestamp is correct");
                    });
                    after(() => {
                        newFs = undefined!;
                        actualReadFileMap = undefined!;
                        host = undefined!;
                    });
                    if (!baselineOnly) {
                        it(`verify diagnostics`, () => {
                            host.assertDiagnosticMessages(...(incrementalExpectedDiagnostics || emptyArray));
                        });
                    }
                    it(`Generates files matching the baseline`, () => {
                        generateBaseline(newFs, proj, scenario, subScenario, fs);
                    });
                    if (!baselineOnly) {
                        it("verify readFile calls", () => {
                            verifyReadFileCalls(actualReadFileMap, Debug.assertDefined(incrementalExpectedReadFiles));
                        });
                    }
                    it(`Verify emit output file text is same when built clean`, () => {
                        const expectedOutputFiles = Debug.assertDefined(outputFiles);
                        const { fs } = build({
                            fs: newFs.shadow(),
                            tick,
                            rootNames,
                            expectedMapFileNames: emptyArray,
                            modifyFs: fs => {
                                // Delete output files
                                for (const outputFile of expectedOutputFiles) {
                                    if (fs.existsSync(outputFile)) {
                                        fs.rimrafSync(outputFile);
                                    }
                                }
                            },
                        });

                        for (const outputFile of expectedOutputFiles) {
                            const expectedText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : undefined;
                            const actualText = newFs.existsSync(outputFile) ? newFs.readFileSync(outputFile, "utf8") : undefined;
                            assert.equal(actualText, expectedText, `File: ${outputFile}`);
                        }
                    });
                });
            }
            if (incrementalDtsChangedBuild) {
                incrementalBuild(
                    "incremental declaration changes",
                    incrementalDtsChangedBuild.modifyFs,
                    incrementalDtsChangedBuild.expectedDiagnostics,
                    incrementalDtsChangedBuild.expectedReadFiles,
                );
            }

            if (incrementalDtsUnchangedBuild) {
                incrementalBuild(
                    "incremental declaration doesnt change",
                    incrementalDtsUnchangedBuild.modifyFs,
                    incrementalDtsUnchangedBuild.expectedDiagnostics,
                    incrementalDtsUnchangedBuild.expectedReadFiles
                );
            }

            if (incrementalHeaderChangedBuild) {
                incrementalBuild(
                    "incremental headers change without dts changes",
                    incrementalHeaderChangedBuild.modifyFs,
                    incrementalHeaderChangedBuild.expectedDiagnostics,
                    incrementalHeaderChangedBuild.expectedReadFiles
                );
            }
        });
    }
}

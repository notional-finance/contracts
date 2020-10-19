module.exports = {
    isUserMethod: (visibility, natspec) => {
        if (visibility === "public" || visibility === "external") {
            if (
                natspec.devdoc !== undefined &&
                (natspec.devdoc.trim() === "skip" ||
                    natspec.devdoc.trim() === "governance")
            ) {
                return false;
            }

            return true;
        }

        return false;
    },
    isGovernance: (visibility, natspec) => {
        if (
            (visibility === "public" || visibility === "external") &&
            natspec.devdoc !== undefined &&
            natspec.devdoc.trim() == "governance"
        ) {
            return true;
        }

        return false;
    },
    hasGovernance: ownFunctions => {
        if (Array.isArray(ownFunctions)) {
            for (let func of ownFunctions) {
                if (
                    (func.visibility === "public" ||
                        func.visibility === "external") &&
                    func.natspec.devdoc !== undefined &&
                    func.natspec.devdoc.trim() == "governance"
                ) {
                    return true;
                }
            }
        }

        return false;
    },
    hasEvents: ownEvents => {
        if (Array.isArray(ownEvents) && ownEvents.length > 0) {
            return true;
        }

        return false;
    },
    trim: s => {
        return s.trim();
    }
};
